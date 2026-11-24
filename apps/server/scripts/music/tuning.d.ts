export interface Tuning {
  /** Share of tonal energy more than 10 / 20 cents off a note (150-2500 Hz). */
  off10: number
  off20: number
  /** Share on pitch classes outside the piece's key. */
  outKey: number
  /** Share more than 4 cents off at fine resolution (150-1500 Hz): detuned copies of a note. */
  fine: number
}
export function tuningOf(wav: Buffer, about: string, rate?: number): Tuning
