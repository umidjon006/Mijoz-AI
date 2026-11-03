/**
 * FAQAT HARNESS. Modul sahifalarini lokal "qobiq" ichida ko'rsatadi:
 * soxta auth header'lari + `/api` proxy.
 *
 * Asosiy repoda bu fayl o'rniga o'z `App.tsx`/router'ingiz bo'ladi va
 * `request` funksiyasi sizning `api.ts` dan keladi.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { TrainingApp } from '../../../module/frontend/src/TrainingApp.js';
import { createTrainingApi, type ApiRequestInit } from '../../../module/frontend/src/lib/api.js';
import '../../../module/frontend/src/styles.css';

/** Soxta auth: header'lar bilan dev foydalanuvchi (faqat lokal). */
const DEV_HEADERS: Record<string, string> = {
  'x-business-id': '11111111-1111-1111-1111-111111111111',
  'x-user-id': '22222222-2222-2222-2222-222222222222',
};

async function request<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  // Ovozli navbat XOM `audio/wav` yuboradi — JSON ga o'ralmaydi.
  const raw = init.rawBody;
  const response = await fetch(path, {
    method: init.method ?? 'GET',
    headers: {
      ...DEV_HEADERS,
      ...(raw !== undefined ? { 'content-type': init.contentType ?? 'application/octet-stream' } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(raw !== undefined ? { body: raw } : {}),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    let detail = raw;
    try {
      // Server: { error, message, category? } — `message` toifa bilan boshlanadi (`[timeout] ...`).
      const body = JSON.parse(raw) as { error?: string; message?: string; category?: string };
      if (body.message) {
        detail = `${body.error ?? 'xato'}: ${body.message}`;
      }
    } catch {
      // JSON emas — matnning o'zi.
    }
    // Tana xatoga biriktiriladi — modul UI'si `stage` ni shundan o'qiydi
    // (`describeApiError`), foydalanuvchi xom JSON ko'rmaydi.
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      // JSON emas.
    }
    throw Object.assign(new Error(`${response.status} ${detail.slice(0, 400)}`), {
      status: response.status,
      body,
    });
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text.length > 0 ? JSON.parse(text) : undefined) as T;
}

const api = createTrainingApi(request);

interface HarnessInfo {
  profileKey: string;
  industry: string;
  callDirection: 'inbound' | 'outbound' | 'mixed';
  llm: string;
  model?: string;
  isDemo?: boolean;
  voice?: { enabled: boolean; sttModel?: string; ttsModel?: string; missing?: string[] };
}

function Shell(): JSX.Element {
  const [info, setInfo] = useState<HarnessInfo | null>(null);

  useEffect(() => {
    void request<HarnessInfo>('/api/v1/training/_harness')
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  const isDemo = info?.isDemo === true;

  return (
    <>
      {/* DEMO rejimi ko'zga tashlanib tursin: javoblar haqiqiy model emas. */}
      {isDemo ? (
        <div
          style={{
            font: '600 13px system-ui, sans-serif',
            background: '#b3261e',
            color: '#fff',
            padding: '8px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
          role="status"
        >
          <span
            style={{
              background: '#fff',
              color: '#b3261e',
              borderRadius: 999,
              padding: '2px 10px',
              letterSpacing: '0.06em',
            }}
          >
            DEMO AI
          </span>
          <span style={{ fontWeight: 400 }}>
            Bu haqiqiy model emas (DEMO_LLM=1). Javoblar sodda va qolipli — sifat,
            kechikish yoki narx haqida xulosa chiqarmang.
          </span>
        </div>
      ) : null}
      <div
        style={{
          font: '13px system-ui, sans-serif',
          background: '#fff7e6',
          color: '#7a5200',
          borderBottom: '1px solid #f0d79a',
          padding: '6px 12px',
        }}
      >
        <b>Lokal harness</b>
        {info ? (
          <>
            {' '}
            · profil: {info.profileKey} ({info.industry}) · LLM: {info.llm}
            {info.model ? ` (${info.model})` : ''}
            {' · ovoz: '}
            {info.voice?.enabled
              ? `${info.voice.sttModel ?? '?'} / ${info.voice.ttsModel ?? '?'}`
              : `o'chiq${info.voice?.missing?.length ? ` (${info.voice.missing.join(', ')})` : ''}`}
          </>
        ) : (
          ' · backend ulanmadi: `npm run serve` ishlayaptimi?'
        )}
      </div>
      <TrainingApp
        api={api}
        callDirection={info?.callDirection ?? 'mixed'}
        voiceEnabled={info?.voice?.enabled === true}
        canViewAll
        debug
      />
    </>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root topilmadi');
createRoot(container).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
