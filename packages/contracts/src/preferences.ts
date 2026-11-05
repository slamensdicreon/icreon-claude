import { z } from 'zod';

/** The Dial's two faces. */
export const ScreenMode = z.enum(['bliss', 'everything']);
export type ScreenMode = z.infer<typeof ScreenMode>;

/**
 * What the Control Center remembers per operator (`GET/PUT /me/preferences`): the mode each screen
 * was last left in, keyed by screen ("dashboard", "mission", "plan", …). The browser keeps the
 * same map first; the server's copy follows the operator to another device.
 */
export const MePreferences = z.object({
  mode: z.record(z.string().min(1).max(40), ScreenMode).default({}),
});
export type MePreferences = z.infer<typeof MePreferences>;
