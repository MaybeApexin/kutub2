/**
 * A global (bot-wide, not per-user) cooldown gate. Needed because a Gemini API
 * key's requests-per-minute limit is shared across every Discord user hitting the
 * bot at once — a per-user cooldown wouldn't protect that shared budget, since
 * several different users invoking the command around the same time would still
 * collectively blow past it even if each individually waited their turn.
 */
export function createCooldown(minIntervalMs: number) {
  let lastRunAt = 0;

  return {
    /** If a run may start now, reserves this slot and returns null. Otherwise
     *  returns how many milliseconds the caller must still wait. */
    tryAcquire(): number | null {
      const now = Date.now();
      const elapsed = now - lastRunAt;
      if (elapsed >= minIntervalMs) {
        lastRunAt = now;
        return null;
      }
      return minIntervalMs - elapsed;
    },
  };
}
