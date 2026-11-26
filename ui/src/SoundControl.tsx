import { soundPlayer, type SoundPlayer } from "./sounds";
import { useMuted } from "./useTurnSounds";

// One speaker button that mutes or unmutes the alert sounds (saved in this browser), and a small Test link that
// plays every bot's sound once, even when muted, so the owner can hear them.
export function SoundControl({ player = soundPlayer() }: { player?: SoundPlayer }) {
  const muted = useMuted(player);
  return (
    <span className="sound-control">
      <button
        type="button"
        className="sound-toggle"
        aria-label={muted ? "Unmute sounds" : "Mute sounds"}
        aria-pressed={muted}
        title={muted ? "Sounds are off. Click to turn them on." : "Sounds are on. Click to mute."}
        onClick={() => { player.unlock(); player.toggleMuted(); }}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" />
          {muted ? <path d="M17 9l5 6M22 9l-5 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}
        </svg>
      </button>
      <button type="button" className="sound-test" title="Play each bot's sound" onClick={() => player.test()}>
        Test sounds
      </button>
    </span>
  );
}
