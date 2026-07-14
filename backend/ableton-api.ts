import { Ableton } from 'ableton-js';
import { Track } from 'ableton-js/ns/track';
import { Clip } from 'ableton-js/ns/clip';
import { DeviceParameter } from 'ableton-js/ns/device-parameter';
import * as socketio from 'socket.io';
import * as nodeOSC from 'node-osc';
import throttle from 'lodash.throttle';
import memoize from 'lodash.memoize';
import logger from './utils/logger';
import { FindNextPhraseLeader } from './utils/is-new-phrase-leader';
import { ClipBoard, ClipInfo, ClipList, ClipMetadataType, ClipTypes, WarpMarker } from './types';

import EmitEvent, { EmitEventWithoutResetingTimout } from './events/outgoing-events';
import { AddSocketEventsHandlers, OSCEventHandlers } from './events/incoming-events';
import { ClipNameToInfoMap } from './utils/get-clip-from-rfid';
import { transpositions } from './key-transpositions';

let oscServer: nodeOSC.Server;
export const sockets: socketio.Socket[] = [];
export const TIMEOUT_IN_MILISECONDS = 60 * 3 * 1000; // three minutes
export const TIMEOUT_WARNING_IN_MILISECONDS = 30 * 1000; // thirty seconds

export let timeoutId: NodeJS.Timeout;
export let timeoutWarningId: NodeJS.Timeout;
export const ATTRACTOR_STATE_CLIP_NAME = 'Wicked Casting';
export let allAbletonClips: ClipBoard;
export let tracks: Track[];
export let trackVolumes: Array<DeviceParameter>;
export let phraseLeader: ClipInfo;
export let cleanUpPhraseLeaderEventListener: any;

export let keyLockEnabled = true;
export let masterKey = '';
export let drumRackClips: Clip[];
const DRUM_RACK_TRACK_INDEX = parseInt(process.env.DRUM_RACK_TRACK_INDEX as string, 10);
export const stoppingClips: ClipList = [];
export const playingClips: ClipList = [];
export const queuedClips: ClipList = [];

export const ableton = new Ableton({ logger: logger });

export const TRIGGER_ORDER = [ClipTypes.Drums, ClipTypes.Melody, ClipTypes.Bass, ClipTypes.Vox];
export const KEY_LEADER_ORDER = [ClipTypes.Vox, ClipTypes.Melody, ClipTypes.Bass, ClipTypes.Drums];

export async function StartAbleton() {
  logger.info('Starting AbletonJS');
  await ableton.start();
  await GetTracksAndClips();
  await GetTrackVolumes();
  await GetDrumRackClips();
}

export async function GetDrumRackClips() {
  logger.info('Fetching drum rack clips from Ableton');
  const track = tracks[DRUM_RACK_TRACK_INDEX];
  if (!track) {
    logger.warn(`No drum rack track found at index ${DRUM_RACK_TRACK_INDEX}`);
    drumRackClips = [];
    return drumRackClips;
  }
  const clipSlots = await track.get('clip_slots');
  const clips = await Promise.all(clipSlots.map((cs) => cs.get('clip')));
  drumRackClips = clips.filter((clip): clip is Clip => clip !== null);
  logger.info(`Found ${drumRackClips.length} drum rack clips on track "${track.raw.name}"`);
  return drumRackClips;
}

export const TriggerRandomDrumSample = throttle(
  async function () {
    if (!drumRackClips) await GetDrumRackClips();
    if (!drumRackClips.length) {
      logger.warn('No drum rack clips to trigger');
      return;
    }
    const clip = drumRackClips[Math.floor(Math.random() * drumRackClips.length)];
    logger.info(`Triggering drum sample "${clip.raw.name}"`);
    EmitEvent('cauldron_sample_triggered', { clipName: clip.raw.name });
    await clip.fire();
  },
  200,
  { trailing: false },
);

export async function handleTimeout() {
  for (let i = 0; i < 4; i++) {
    await tracks[i].sendCommand('stop_all_clips');
  }
  masterKey = '';
}

export function startTimeoutTimer() {
  logger.info('Starting timeout timer');
  function shouldShowTimeout() {
    return (
      playingClips.filter((clip) => clip).length > 0 &&
      stoppingClips.filter((clip) => clip).length === 0
    );
  }
  timeoutWarningId = setTimeout(() => {
    if (shouldShowTimeout()) {
      logger.warn('Timeout warning');
      EmitEventWithoutResetingTimout('timeout_warning');
    }
  }, TIMEOUT_IN_MILISECONDS - TIMEOUT_WARNING_IN_MILISECONDS);
  timeoutId = setTimeout(() => {
    if (shouldShowTimeout()) {
      logger.warn('Timeout exceeded, restarting the UI');
      handleTimeout();
    }
  }, TIMEOUT_IN_MILISECONDS);
}

export function restartTimeoutTimer() {
  logger.warn('Restarting timeout timer');
  clearTimeout(timeoutId);
  clearTimeout(timeoutWarningId);
  startTimeoutTimer();
}

export function ConnectOSCServer(server: nodeOSC.Server) {
  oscServer = server;
  oscServer.on('message', OSCEventHandlers);
}

const MemoizedClipIndex = memoize(
  (clipName, pillar) =>
    allAbletonClips[pillar].findIndex((clip) => {
      return clip?.raw.name.trim() === clipName.trim();
    }),
  (clipName, pillar) => `${clipName}-${pillar}`,
);

export function AddWebSocket(s: socketio.Socket) {
  s.on('disconnect', () => {
    logger.info('Web client disconnected');
    const disconnectedSocketIndex = sockets.findIndex((socket) => socket === s);
    sockets.splice(disconnectedSocketIndex, 1);
  });
  // s.onAny((eventName, ...args) => {
  //   logger.info(`Received event ${eventName} with data: ${args}`);
  // });
  sockets.push(s);
  AddSocketEventsHandlers(s);
}

const FindAllClipsInLoop = memoize(
  (clipName, pillar) => {
    logger.info(`Trying to find all clips in loop on pillar ${pillar + 1} > ${clipName}`);
    const firstClipIndex = MemoizedClipIndex(clipName, pillar);
    if (firstClipIndex < 0) return [];

    const lastClipIndex = allAbletonClips[pillar]
      .slice(firstClipIndex, firstClipIndex + 20)
      .findLastIndex((clip) => {
        return clip?.raw.name.trim() === clipName.trim();
      });
    logger.debug(
      `Loop for ${clipName} found on ${pillar + 1} > [${firstClipIndex}, ${
        firstClipIndex + lastClipIndex + 1
      }]`,
    );
    return allAbletonClips[pillar].slice(firstClipIndex, firstClipIndex + lastClipIndex + 1);
  },
  (clipName, pillar) => `${clipName}-${pillar}`,
);

// function FindAllClipsInLoop(clipName: string, pillar: number) {
//   logger.info(`Trying to find all clips in loop on pillar ${pillar + 1} > ${clipName}`);
//   const firstClipIndex = MemoizedClipIndex(clipName, pillar);
//   console.log('clips', firstClipIndex);
//   if (firstClipIndex < 0) return [];

//   const lastClipIndex = allAbletonClips[pillar]
//     .slice(firstClipIndex, firstClipIndex + 20)
//     .findLastIndex((clip) => {
//       return clip?.raw.name.trim() === clipName.trim();
//     });
//   logger.debug(`Loop: ${pillar + 1} > [${firstClipIndex}, ${firstClipIndex + lastClipIndex + 1}]`);
//   return allAbletonClips[pillar].slice(firstClipIndex, firstClipIndex + lastClipIndex + 1);
// }

export function QueueClip(clipMetadata: ClipMetadataType, pillar: number) {
  const { clipName, key } = clipMetadata;
  logger.info(`Begin queing clip ${clipName}`);
  if (queuedClips[pillar]?.clipName.replace(/[* ]/g, '') === clipName.replace(/[* ]/g, '')) {
    logger.info(`Clip ${clipName} is already queued`);
    return;
  }
  const clips = FindAllClipsInLoop(clipName, pillar);
  console.log('clips', clips);
  if (clips.length) {
    // if no items are playing, skip the queue
    const silence = playingClips.every((clip) => !clip);

    if (playingClips.every((item) => !item) || masterKey === '') {
      // we're coming from a silent state, or an undefined key state, so let's try to set master key
      clipMetadata.key && SetMasterKey(key ?? '');
    }

    // TODO: transpose all clips in a block (even when toggling the key lock)
    keyLockEnabled &&
      clips.forEach(
        (clip) => clip && transposeClipToNewKey({ ...clipMetadata, clip, pillar }, masterKey),
      );
    if (silence) {
      logger.info(`Triggering clip "${clipName}" on pillar ${pillar + 1}`);
      clips[0]?.fire();
    } else if (clips[0]) {
      logger.info(`Queuing clip "${clipName}" on pillar ${pillar + 1}`);
      queuedClips[pillar] = {
        clip: clips[0],
        pillar,
        ...clipMetadata,
      };
      EmitEvent('clip_queued', {
        pillar,
        ...clipMetadata,
      });
    }
  } else {
    logger.warn(`No clip "${clipName}" found on pillar ${pillar + 1}`);
    EmitEvent('clip_unqueued', {
      ...clipMetadata,
      pillar,
    });
  }
}

export async function TriggerQueuedClips() {
  logger.info(`Begin triggering clip queue`);
  for (let i = 0; i < queuedClips.length; i++) {
    const item = queuedClips[i];
    if (!item) continue;
    logger.info(`Triggering clip "${item.clip.raw.name}" on pillar ${item.pillar} `);
    await item.clip.fire();
    queuedClips[item.pillar] = null;
  }
}

export async function StopOrRemoveClipFromQueue(clipName: string, pillar: number) {
  logger.trace(`Try to stop or unqueue clip ${clipName}`);
  const playingClip = playingClips[pillar];
  const queuedClip = queuedClips[pillar];

  const isClipPlaying =
    playingClip?.clipName.replace(/[* ]/g, '') === clipName.replace(/[* ]/g, '');
  if (isClipPlaying) {
    logger.info(`Stopping clip "${clipName}" on pillar ${pillar + 1}`);
    stoppingClips[pillar] = playingClip;
    // clip.stop() won't work because of looping: stop the whole track instead.
    EmitEvent('clip_stopping', {
      ...playingClip,
      clip: undefined,
    });
    await tracks[pillar].sendCommand('stop_all_clips');

    playingClips[pillar] = null;
    if (playingClip.clipName.replace(/[* ]/g, '') === phraseLeader.clipName.replace(/[* ]/g, '')) {
      // Find the next phrase leader, check if such a clip is playing,
      // then promote that clip to phrase leader else trigger queued clips and let god sort it out.
      const promotedClip = FindNextPhraseLeader(playingClips);
      if (promotedClip) {
        AddPhraseLeader(promotedClip);
      } else {
        TriggerQueuedClips();
      }
    }
  }

  // check if the clip is queued
  const isClipQueued = queuedClip?.clipName.replace(/[* ]/g, '') === clipName.replace(/[* ]/g, '');
  if (isClipQueued) {
    logger.info(`Removing clip from queue "${clipName}" on pillar ${pillar + 1}`);
    if (keyLockEnabled) {
      const queuedClipsInLoop = FindAllClipsInLoop(clipName, pillar);

      queuedClipsInLoop.forEach(
        (clip) => clip !== null && transposeClipToNewKey({ ...queuedClip, clip }, ''),
      );
    }
    queuedClips[pillar] = null;
    EmitEvent('clip_unqueued', {
      ...queuedClip,
      clip: undefined,
    });
  }

  if (!isClipPlaying && !isClipQueued) {
    logger.warn(
      `Clip ${clipName} is neither playing or queue. Stopping pillar ${pillar + 1} just in case.`,
    );
    await tracks[pillar].sendCommand('stop_all_clips');
    EmitEventWithoutResetingTimout('clip_stopped', { pillar });
  }
}

export async function AddPhraseLeader(newPhraseLeader: ClipInfo) {
  if (cleanUpPhraseLeaderEventListener) cleanUpPhraseLeaderEventListener();
  phraseLeader = newPhraseLeader;

  const { clip, clipName, pillar } = newPhraseLeader;
  logger.info(`New phrase leader "${clipName}" on pillar ${pillar + 1}`);

  // figure out when this clip is about to end
  const endTime = await clip.get('loop_end');
  logger.debug(`Loop end on pillar ${pillar + 1} > "${clipName}" | ${endTime}`);
  cleanUpPhraseLeaderEventListener = await clip.addListener(
    'playing_position',
    throttle(
      function (clip: ClipInfo, endTime: number, currentTime: number) {
        if (currentTime >= endTime - 1) {
          logger.info(
            `Clip ending soon on pillar ${clip.pillar} > "${clip.clipName}" | ${currentTime} / ${endTime}`,
          );
          if (cleanUpPhraseLeaderEventListener) cleanUpPhraseLeaderEventListener();
          TriggerQueuedClips();
        }
      }.bind({}, newPhraseLeader, endTime),
      300,
    ),
  );
}

export const GetTracksAndClips = async () => {
  logger.info('Fetching tracks and clips from Ableton');
  // 2-D array of all the clips, ordered by Track
  allAbletonClips = [];
  tracks = await ableton.song.get('tracks');

  for (let pillar = 0; pillar < 4; pillar++) {
    const track = tracks[pillar];
    const clipSlots = await track.get('clip_slots');

    track.addListener('playing_slot_index', async (clipSlotIndex: number) => {
      logger.info('Playing slot index changed: ' + clipSlotIndex);
      if (clipSlotIndex >= 0) {
        const clip = allAbletonClips[pillar][clipSlotIndex];
        const clipName = clip?.raw.name;
        if (clipName) {
          const clipMetadata = ClipNameToInfoMap[clipName.replace(/[* ]/g, '')];
          const clipInfo = {
            ...clipMetadata,
            clipName,
            pillar,
          };

          logger.info(`Pillar ${pillar + 1} started playing ${clipName}`);
          if (!clipMetadata) {
            throw new Error(`Couldn't find clip metadata for "${clipName}"`);
          }

          if (playingClips[pillar]?.clipName && clipName !== playingClips[pillar]?.clipName) {
            // In the case where a whole new song gets queued and triggered without the previous
            // song being stopped, we need to make sure that we transpose the previous song back to 0
            const previousClipsInLoop = FindAllClipsInLoop(playingClips[pillar]?.clipName, pillar);
            previousClipsInLoop.forEach(
              (clip) =>
                clip && transposeClipToNewKey({ ...(playingClips[pillar] as ClipInfo), clip }, ''),
            );
          }

          const warpMarkers = await clip.get('warp_markers');
          const bpm = CalculateBPMFromWarpMarkers(warpMarkers);
          const browserInfo = { ...clipInfo, bpm };
          if (playingClips[pillar]?.clipName === clipName) {
            EmitEventWithoutResetingTimout('clip_playing', browserInfo);
          } else {
            EmitEvent('clip_started', browserInfo);
            SetTrackVolume(pillar, 0.6);
          }
          if (playingClips.every((item) => !item)) {
            // we're coming from a silent state, so let's set the tempo to this new clip's bpm
            SetTempo(bpm);
            clipMetadata.key && SetMasterKey(clipMetadata.key);
          }

          playingClips[pillar] = { ...clipInfo, clip };

          const newPhraseLeader = FindNextPhraseLeader(playingClips);
          if (newPhraseLeader?.clipName === clipName) {
            AddPhraseLeader(newPhraseLeader);
          }
        }
      } else {
        const clipInfo = stoppingClips[pillar];
        logger.info(`Clip stopped playing on pillar ${pillar + 1} > "${clipInfo?.clipName}"`);
        EmitEventWithoutResetingTimout('clip_stopped', {
          ...clipInfo,
          pillar,
          clip: undefined,
        });

        if (clipInfo?.clipName && keyLockEnabled) {
          // const stoppingClipsInLoop = FindAllClipsInLoop(clipInfo?.clipName, pillar);
          // stoppingClipsInLoop.forEach(
          //   (clip) => clip && transposeClipToNewKey({ ...clipInfo, clip }, ''),
          // );
          const playingClipsInLoop = FindAllClipsInLoop(clipInfo?.clipName, pillar);
          playingClipsInLoop.forEach(
            (clip) => clip && transposeClipToNewKey({ ...clipInfo, clip }, ''),
          );
        }

        stoppingClips[pillar] = null;
        playingClips[pillar] = null;
      }
    });

    allAbletonClips.push([]);

    for (let clipSlotIndex = 0; clipSlotIndex < clipSlots.length; clipSlotIndex++) {
      const cs = clipSlots[clipSlotIndex];
      const clip = await cs.get('clip');
      allAbletonClips[pillar].push(clip);
      // const previousClipName = clipSlotIndex
      //   ? (await clipSlots[clipSlotIndex - 1].get('clip'))?.raw.name
      //   : null;
      // const clipName = clip?.raw.name;
      // const checkDatabase =
      //   previousClipName && clipName ? previousClipName !== clipName : clipName ? true : false;
      // if (checkDatabase) {
      //   const info = ClipNameToInfoMap[clipName?.replace(/[ ]/g, '') as string];
      //   if (!info)
      //     logger.error(
      //       `Could not find clip: ${pillar + 1} | ${clipSlotIndex} / "${clipName}" in database`,
      //     );
      // }
    }
  }
  logger.info('Tracks and clips from Ableton fetched');

  return { allAbletonClips, tracks };
};

export async function GetTempo() {
  logger.info('Getting tempo');
  return ableton.song.get('tempo');
}

export function SetTempo(tempo: number) {
  logger.info(`Setting tempo to: ${tempo}`);
  ableton.song.set('tempo', tempo);
  EmitEvent('tempo_changed', { tempo });
}

export async function GetTrackVolumes() {
  logger.info('Getting track volumes');
  trackVolumes = [];
  for (const track of tracks.slice(0, 4)) {
    const mixerDevice = await track.get('mixer_device');
    const deviceParameter = await mixerDevice.sendCommand('get_volume');
    logger.debug(
      `Getting volume device parameter for track ${track.raw.name}: ${JSON.stringify(
        deviceParameter,
      )}`,
    );
    trackVolumes.push(new DeviceParameter(ableton, deviceParameter));
  }
}

export async function SetTrackVolume(pillar: number, volume: number) {
  logger.info(`Setting volume for pillar ${pillar + 1} to ${volume}`);
  if (!trackVolumes?.length) await GetTrackVolumes();
  const trackVolume = trackVolumes[pillar];
  await trackVolume?.set('value', volume);
  EmitEvent('volume_changed', { pillar, volume });
}

export function CalculateBPMFromWarpMarkers(warp_markers: WarpMarker[]) {
  const { beat_time: startBT, sample_time: startST } = warp_markers[0];
  const { beat_time: endBT, sample_time: endST } = warp_markers.slice(-1)[0];
  const bpm = (endBT - startBT) / ((endST - startST) / 60);
  return bpm;
}

export function GetKeyLockState() {
  return keyLockEnabled;
}

export function SetKeyLockState(state: boolean) {
  keyLockEnabled = state;

  logger.info(`Key lock: ${state}`);
  playingClips.forEach((song, pillar) => {
    song &&
      FindAllClipsInLoop(song.clipName, pillar).forEach((clip) => {
        clip && transposeClipToNewKey({ ...song, clip }, keyLockEnabled ? masterKey : '');
      });
  });
  queuedClips.forEach((song, pillar) => {
    song &&
      FindAllClipsInLoop(song.clipName, pillar).forEach((clip) => {
        clip && transposeClipToNewKey({ ...song, clip }, keyLockEnabled ? masterKey : '');
      });
  });
}

export function GetMasterKey() {
  return masterKey;
}

export function SetMasterKey(newKey: string) {
  masterKey = newKey;
  EmitEvent('master-key_changed', { key: newKey });
  if (keyLockEnabled) {
    playingClips.forEach((song, pillar) => {
      song &&
        FindAllClipsInLoop(song.clipName, pillar).forEach((clip) => {
          clip && transposeClipToNewKey({ ...song, clip }, newKey);
        });
    });
    queuedClips.forEach((song, pillar) => {
      song &&
        FindAllClipsInLoop(song.clipName, pillar).forEach((clip) => {
          clip && transposeClipToNewKey({ ...song, clip }, newKey);
        });
    });
  }
}

export function transposeClipToNewKey(item: ClipInfo, newKey: string) {
  const { key, clip, clipName } = item;
  if (!newKey || key === newKey) {
    logger.info(`Resetting clip "${clipName}" to original key`);
    clip.set('pitch_coarse', 0);
  } else if (key) {
    const trackKeyPitch = key.match(/[A-Z]/g)?.[0];
    const newKeyPitch = newKey.match(/[A-Z]/g)?.[0];
    const newKeyNumber = Number(newKey.match(/\d+/g)?.[0] ?? 1);
    const backupKey = `${newKeyNumber}${trackKeyPitch}`;
    const transposeAmount =
      (newKeyPitch === trackKeyPitch
        ? transpositions[key][newKey]
        : transpositions[key][backupKey]) ?? 0;

    logger.info(
      `Transposing clip "${clipName}" from ${key} to ${
        newKeyPitch === trackKeyPitch ? newKey : backupKey
      } > ${transposeAmount ?? 0}`,
    );
    clip.set('pitch_coarse', transposeAmount);
  } else {
    logger.warn(`Cannot transpose clip "${item.clipName}": it does not have a key`);
  }
}
