interface ChosenEffectsProps {
  transitionValue?: string | null;
  openingTransition?: string | null;
  closingTransition?: string | null;
  soundMood?: string | null;
}

const TRANSITION_LABELS: Record<string, string> = {
  none: "No transition",
  crossfade: "Crossfade",
  dip_to_black: "Dip to black",
  wipe: "Wipe",
  wipe_down: "Wipe down",
  zoom: "Zoom",
  dissolve: "Dissolve",
  barn_door: "Barn door",
  band_wipe: "Band wipe",
  shuffle: "Shuffle",
};

const MOOD_LABELS: Record<string, string> = {
  none: "No music",
  cinematic: "Cinematic",
  upbeat: "Upbeat",
  chill: "Chill",
  electronic: "Electronic",
  custom: "Custom track",
};

export function ChosenEffects({ transitionValue, openingTransition, closingTransition, soundMood }: ChosenEffectsProps) {
  const hasTransition = !!transitionValue && transitionValue !== "none";
  const hasOpening = !!openingTransition && openingTransition !== "none";
  const hasClosing = !!closingTransition && closingTransition !== "none";
  const hasMood = !!soundMood && soundMood !== "none";
  const hasAny = hasTransition || hasOpening || hasClosing || hasMood;

  return (
    <div data-testid="chosen-effects" className="px-3 py-3 h-full">
      <p className="text-[10px] text-[#a3a3a3] uppercase tracking-widest mb-2 font-medium">
        Effects
      </p>
      {!hasAny ? (
        <p className="text-xs text-[#a3a3a3] italic">None set</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {hasTransition && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-[#99B3FF]/20 border border-[#99B3FF]/50 text-[#99B3FF] w-fit">
              {TRANSITION_LABELS[transitionValue!] ?? transitionValue}
            </span>
          )}
          {hasOpening && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-[#99B3FF]/20 border border-[#99B3FF]/50 text-[#99B3FF] w-fit">
              Fade in
            </span>
          )}
          {hasClosing && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-[#99B3FF]/20 border border-[#99B3FF]/50 text-[#99B3FF] w-fit">
              Fade out
            </span>
          )}
          {hasMood && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-[#99B3FF]/20 border border-[#99B3FF]/50 text-[#99B3FF] w-fit">
              {MOOD_LABELS[soundMood!] ?? soundMood}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
