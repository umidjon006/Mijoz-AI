/**
 * Taqdimot rejimi (rahbariyatga ko'rsatish): host `TrainingApp` ga
 * `presentation` beradi, sahifalar shu kontekstdan o'qiydi —
 * debug paneli yo'q, xatolar do'stona, STT tekshiruvi default.
 */
import { createContext, useContext } from 'react';

export const PresentationContext = createContext(false);

export function usePresentation(): boolean {
  return useContext(PresentationContext);
}
