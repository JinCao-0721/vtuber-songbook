export type AudioTrack = {
  src: string;
  label: string;
  source: string;
  quality?: string;
};

export type Song = {
  slug: string;
  vupId: string;
  title: string;
  type: '翻唱' | '原创' | 'BGM';
  artist: string;
  originalArtist?: string;
  categories?: string[];
  date: string;
  duration: string;
  description: string;
  accent: string;
  audio: AudioTrack[];
  links: { bilibili?: string; qq?: string };
};

import songData from '../../data/songs.json';

export const songs: Song[] = songData as Song[];
