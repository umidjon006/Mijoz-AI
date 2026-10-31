/**
 * FAQAT HARNESS. Raqam -> o'zbek so'zi.
 *
 * TARIX: bu mantiq Phase A da shu yerda yozilgan edi (WER/CER ni adolatli
 * hisoblash uchun: odam "1 200 000" ni "bir million ikki yuz ming" deb
 * o'qiydi, STT esa raqam bilan yozishi mumkin).
 *
 * Phase B da u `module/.../voice/speech-text.ts` ga KO'CHIRILDI va to'liq
 * sinaladi (`verify:training:voice`): endi ovozli navbat ham, benchmark ham
 * AYNAN bir xil mantiqqa tayanadi. Shuning uchun bu fayl faqat qayta
 * eksport qiladi — ikkinchi nusxa saqlanmaydi.
 */
export {
  digitsOneByOne,
  digitsToUzbekWords,
  normalizeForSpeech,
  numberToUzbekWords,
} from '../../../module/backend/src/training/voice/speech-text.js';
