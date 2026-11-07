/**
 * Modulning frontend kirish nuqtasi.
 *
 * Ikki xil ishlatish mumkin:
 *  1. `<TrainingApp api={...} />` — ichida oddiy ko'rinish almashuvi bor,
 *     host ilovaga faqat bitta marshrut (`/mashq`) qo'shish kifoya;
 *  2. sahifalarni alohida import qilib, host ilovaning router'iga ulash
 *     (`MashqPage`, `SessionPage`, `NatijaPage`, `TarixPage`).
 *
 * Router kutubxonasi ATAYLAB ishlatilmagan — modul host ilovaning
 * router'iga bog'lanib qolmasligi uchun.
 */
import { useState } from 'react';

import { mashq } from './lugat/mashq.js';
import type { TrainingApi } from './lib/api.js';
import { PresentationContext } from './lib/presentation.js';
import { MashqPage } from './pages/MashqPage.js';
import { NatijaPage } from './pages/NatijaPage.js';
import { SessionPage } from './pages/SessionPage.js';
import { TarixPage } from './pages/TarixPage.js';

export type TrainingView =
  | { name: 'home' }
  | { name: 'session'; sessionId: string }
  | { name: 'result'; sessionId: string }
  | { name: 'history' };

export interface TrainingAppProps {
  api: TrainingApi;
  /** Profildagi `callDirection` (bosh sahifadagi yo'nalish tanlovi uchun). */
  callDirection?: 'inbound' | 'outbound' | 'mixed';
  /** `training:view:all` ruxsati bor-yo'qligi. */
  canViewAll?: boolean;
  /** Debug panellari (harness uchun `true`). */
  debug?: boolean;
  /**
   * Server ovozli navbatni qo'llaydimi. Host buni o'z sozlamasidan biladi
   * (harness `_harness` endpointidan). `false` bo'lsa jonli sahifada ovoz
   * boshqaruvi o'rniga tushuntirish ko'rsatiladi.
   */
  voiceEnabled?: boolean;
  /** Boshlang'ich ko'rinish (host router'idan kelishi mumkin). */
  initialView?: TrainingView;
  /**
   * Taqdimot rejimi (rahbariyatga ko'rsatish): STT tekshiruvi default, debug
   * paneli yo'q, xatolar do'stona o'zbekcha, yuqorida bir bosishli "Yangi mashq".
   */
  presentation?: boolean;
}

export function TrainingApp({
  api,
  callDirection = 'mixed',
  canViewAll = false,
  debug = false,
  voiceEnabled = false,
  initialView = { name: 'home' },
  presentation = false,
}: TrainingAppProps): JSX.Element {
  const [view, setView] = useState<TrainingView>(initialView);
  const [pendingArchetype, setPendingArchetype] = useState<string | null>(null);
  /** Oxirgi mashq qilingan mijoz turi — "Yangi mashq" shu bilan boshlaydi. */
  const [lastArchetype, setLastArchetype] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const showDebug = debug && !presentation;

  async function startWith(archetypeKey: string): Promise<void> {
    try {
      const started = await api.startSession({ archetypeKey });
      setLastArchetype(archetypeKey);
      setView({ name: 'session', sessionId: started.sessionId });
    } catch {
      // Xato bosh sahifada ko'rsatiladi.
      setPendingArchetype(null);
      setView({ name: 'home' });
    }
  }

  /**
   * Bir bosishda yangi mashq: joriy suhbat (bo'lsa) yopiladi va oxirgi
   * (yoki birinchi) mijoz turi bilan darhol yangi sessiya boshlanadi.
   */
  async function newPractice(): Promise<void> {
    if (starting) return;
    setStarting(true);
    try {
      if (view.name === 'session') {
        await api.endSession(view.sessionId, 'new_practice').catch(() => undefined);
      }
      const key = lastArchetype ?? (await api.listArchetypes())[0]?.key;
      if (key) await startWith(key);
      else setView({ name: 'home' });
    } catch {
      setView({ name: 'home' });
    } finally {
      setStarting(false);
    }
  }

  return (
    <PresentationContext.Provider value={presentation}>
      <div className="mq-root">
        <div className="mq-wrap">
          <nav className="mq-nav" aria-label={mashq.appTitle}>
            <button
              type="button"
              onClick={() => setView({ name: 'home' })}
              aria-current={view.name === 'home' ? 'page' : undefined}
            >
              {mashq.navHome}
            </button>
            <button
              type="button"
              onClick={() => setView({ name: 'history' })}
              aria-current={view.name === 'history' ? 'page' : undefined}
            >
              {mashq.navHistory}
            </button>
            {presentation ? (
              <button
                type="button"
                className="mq-btn mq-btn-primary mq-small"
                style={{ marginLeft: 'auto' }}
                disabled={starting}
                onClick={() => void newPractice()}
              >
                {starting ? mashq.newPracticeStarting : mashq.newPractice}
              </button>
            ) : null}
          </nav>

          {view.name === 'home' ? (
            <MashqPage
              api={api}
              callDirection={callDirection}
              onStarted={(sessionId, archetypeKey) => {
                if (archetypeKey) setLastArchetype(archetypeKey);
                setView({ name: 'session', sessionId });
              }}
              onOpenResult={(sessionId) => setView({ name: 'result', sessionId })}
              onOpenHistory={() => setView({ name: 'history' })}
            />
          ) : null}

          {view.name === 'session' ? (
            <SessionPage
              api={api}
              sessionId={view.sessionId}
              debug={showDebug}
              voiceEnabled={voiceEnabled}
              onFinished={(sessionId) => setView({ name: 'result', sessionId })}
              onExit={() => setView({ name: 'home' })}
            />
          ) : null}

          {view.name === 'result' ? (
            <NatijaPage
              api={api}
              sessionId={view.sessionId}
              onRetrySame={(archetypeKey) => {
                setPendingArchetype(archetypeKey);
                void startWith(archetypeKey);
              }}
              onAnotherCustomer={() => setView({ name: 'home' })}
            />
          ) : null}

          {view.name === 'history' ? (
            <TarixPage
              api={api}
              canViewAll={canViewAll}
              onOpenResult={(sessionId) => setView({ name: 'result', sessionId })}
            />
          ) : null}

          {pendingArchetype && view.name === 'result' ? (
            <p className="mq-muted mq-small">{mashq.starting}</p>
          ) : null}
        </div>
      </div>
    </PresentationContext.Provider>
  );
}
