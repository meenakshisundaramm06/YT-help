export interface Video {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string;
  setVideoId: string;
  lengthText: string;
  removed: boolean;
  category: string;
}

export interface Category {
  name: string;
  count: number;
  color: number;
}

// Messages from app → background
export type AppMessage =
  | { type: 'start_scan' }
  | { type: 'remove_videos'; videos: Pick<Video, 'videoId' | 'setVideoId' | 'title'>[] }
  | { type: 'stop' };

// Messages from background → app
export type BgMessage =
  | { type: 'scan_progress'; scanned: number; total: number }
  | { type: 'scan_complete'; videos: Omit<Video, 'removed' | 'category'>[] }
  | { type: 'scan_error'; error: string }
  | { type: 'remove_progress'; done: number; total: number; title: string }
  | { type: 'remove_complete'; removed: number; failed: number }
  | { type: 'remove_error'; error: string };
