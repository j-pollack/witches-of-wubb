import { ReactNode, createContext, useContext, useEffect, useState } from 'react';
import { SocketioContext } from '../contexts/socketio-provider';
import { LoggerContext } from './logger-provider';
import { BrowserClipInfo, BrowserClipInfoList, SetTrackVolumeInputType } from 'backend/types';

export const AbletonContext = createContext({
  getTracksAndClips: () => null,
  changeTempo: (_) => null,
  changeTrackVolume: () => null,
  tempo: 120,
  trackVolume: [],
  queuedClips: [],
  playingClips: [],
  stoppingClips: [],
  clipTempo: [],
  masterKey: '',
  changeMasterKey: (_) => null,
  keylock: true,
  changeKeylock: (_) => null,
  triggerCauldronSample: () => null,
} as {
  getTracksAndClips: () => void;
  changeTempo: (x: number) => void;
  changeTrackVolume: (input: SetTrackVolumeInputType) => void;
  tempo: number;
  trackVolume: number[];
  queuedClips: BrowserClipInfoList;
  playingClips: BrowserClipInfoList;
  stoppingClips: BrowserClipInfoList;
  clipTempo: (number | null)[];
  masterKey: string;
  changeMasterKey: (key: string) => void;
  keylock: boolean;
  changeKeylock: (keylock: boolean) => void;
  triggerCauldronSample: () => void;
});

function UpdateIndex(index: number, newValue: any, initialArray: any[]) {
  const newArray = [...initialArray];
  newArray[index] = newValue;
  return newArray;
}

export default function AbletonProvider({ children }: { children: ReactNode }) {
  const socket = useContext(SocketioContext);
  const { logger } = useContext(LoggerContext);
  const [tempo, setTempo] = useState(120);
  const [masterKey, setMasterKey] = useState<string>('');
  const [keylock, setKeylock] = useState<boolean>(true);
  const [trackVolume, setTrackVolume] = useState<number[]>([]);
  const [queuedClips, setQueuedClips] = useState<BrowserClipInfoList>([]);
  const [playingClips, setPlayingClips] = useState<BrowserClipInfoList>([]);
  const [stoppingClips, setStoppingClips] = useState<BrowserClipInfoList>([]);
  const [clipTempo, setClipTempo] = useState<(number | null)[]>([]);

  useEffect(() => {
    if (socket.connected) {
      getTracksAndClips();

      socket.on('ingredient_detected', (data: BrowserClipInfo) => {
        setQueuedClips(UpdateIndex.bind(null, data.pillar, data));
      });

      socket.on('clip_queued', (data: BrowserClipInfo) => {
        setQueuedClips(UpdateIndex.bind(null, data.pillar, data));
      });
      socket.on('clip_unqueued', (data: BrowserClipInfo) => {
        setQueuedClips(UpdateIndex.bind(null, data.pillar, null));
      });

      socket.on('clip_started', handlePlayingState);

      socket.on('clip_playing', handlePlayingState);

      socket.on('ingredient_removed', (data: BrowserClipInfo) => {
        if (playingClips.findIndex((item) => item?.clipName === data.clipName) > -1) {
          setPlayingClips(UpdateIndex.bind(null, data.pillar, null));
          setStoppingClips(UpdateIndex.bind(null, data.pillar, data));
        } else if (queuedClips.findIndex((item) => item?.clipName === data.clipName)) {
          setQueuedClips(UpdateIndex.bind(null, data.pillar, null));
        }
      });
      socket.on('clip_stopping', (data: BrowserClipInfo) => {
        setPlayingClips(UpdateIndex.bind(null, data.pillar, null));
        setStoppingClips(UpdateIndex.bind(null, data.pillar, data));
      });
      socket.on('clip_stopped', ({ pillar }: { pillar: number }) => {
        setClipTempo(UpdateIndex.bind(null, pillar, null));
        setPlayingClips(UpdateIndex.bind(null, pillar, null));
        setStoppingClips(UpdateIndex.bind(null, pillar, null));
      });
      socket.on('tempo_changed', ({ tempo }: { tempo: number }) => {
        setTempo(tempo);
      });
      socket.on('volume_changed', (data: SetTrackVolumeInputType) => {
        setTrackVolume(UpdateIndex.bind(null, data.pillar, data.volume));
      });
      socket.on('master-key_changed', ({ key }: { key: string }) => {
        setMasterKey(key);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  function getTracksAndClips() {
    socket.emit('get_track_volumes', null, (volumes: number[]) => {
      logger.debug('get_track_volumes returned:', volumes);
      setTrackVolume(volumes);
    });
    socket.emit('get_playing_clips', null, (playingClips: BrowserClipInfoList) => {
      logger.debug('get_playing_clips returned:', playingClips);
      setPlayingClips(playingClips);
    });
    socket.emit('get_queued_clips', null, (queuedClips: BrowserClipInfoList) => {
      logger.debug('get_queued_clips returned:', queuedClips);
      setQueuedClips(queuedClips);
    });
    socket.emit('get_tempo', null, (tempo: number) => {
      logger.debug('get_tempo returned:', tempo);
      setTempo(tempo);
    });
    socket.emit('get_master-key', null, (key: string) => {
      setMasterKey(key);
    });
    socket?.emit('get_keylock_state', null, (state: boolean) => {
      setKeylock(state);
    });
  }

  function changeTempo(tempo: number) {
    socket?.emit('set_tempo', tempo, (tempo: number) => {
      logger.debug('change_tempo returned:', tempo);
      setTempo(tempo);
    });
  }
  function changeTrackVolume(data: SetTrackVolumeInputType) {
    socket?.emit('set_track_volume', data);
  }

  function handlePlayingState(data: BrowserClipInfo) {
    setClipTempo(UpdateIndex.bind(null, data.pillar, data.bpm));
    setPlayingClips(UpdateIndex.bind(null, data.pillar, data));
    setQueuedClips(UpdateIndex.bind(null, data.pillar, null));
    setStoppingClips(UpdateIndex.bind(null, data.pillar, null));
  }

  function changeMasterKey(key: string) {
    logger.debug('set_master-key:', key);
    socket?.emit('set_master-key', key);
  }

  function changeKeylock(newState: boolean) {
    socket?.emit('set_keylock_state', newState, (newState: boolean) => {
      setKeylock(newState);
    });
  }

  function triggerCauldronSample() {
    logger.debug('trigger_cauldron_sample');
    socket?.emit('trigger_cauldron_sample');
  }

  return (
    <AbletonContext.Provider
      value={{
        getTracksAndClips,
        changeTempo,
        tempo,
        trackVolume,
        changeTrackVolume,
        queuedClips,
        playingClips,
        stoppingClips,
        clipTempo,
        masterKey,
        changeMasterKey,
        keylock,
        changeKeylock,
        triggerCauldronSample,
      }}
    >
      {children}
    </AbletonContext.Provider>
  );
}
