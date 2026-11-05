/*
 * /system: every token and every item the app takes from the Cypher Design System, rendered from
 * the same files the app reads (theme/tokens.json, tokens.css, icons, marks, ui/). It is the phase 0
 * exit check: a value here that looks wrong is wrong everywhere. Sample copy is the handoff's Ansell
 * demo hour; in the product Cypher's words come from the API.
 */
import { useState } from 'react';
import tokens from '../theme/tokens.json';
import { Icon, ICON_NAMES } from '../theme/icons';
import { EyeNeedsAWord, EyeResting, EyeWatching, Wordmark } from '../theme/marks';
import { DecisionInbox } from '../ui/decision-inbox';
import { Eye } from '../ui/Eye';
import { SegmentedControl } from '../ui/segmented-control';
import { SmartRecommendation } from '../ui/smart-recommendation';
import { ThinkingLoader } from '../ui/thinking-loader';
import { ToolCallCard, ToolCallGroup } from '../ui/tool-call-card';
import type { EyeState } from '../voice/eye';
import styles from './SystemPage.module.css';

interface Token {
  name: string;
  /** One value, or one per theme (color and shadow). */
  value: string | Record<string, string>;
  usage: string;
}

/** One value, or "light <value> · dark <value>". */
const shown = (v: Token['value']) =>
  typeof v === 'string'
    ? v
    : Object.entries(v)
        .map(([theme, x]) => `${theme} ${x}`)
        .join(' · ');
interface TypeStyle {
  name: string;
  fontSize: string;
  lineHeight: number | string;
  fontWeight: number;
  letterSpacing?: string;
}

const T = tokens as unknown as {
  color: { tokens: Token[] };
  spacing: { tokens: Token[] };
  radius: { tokens: Token[] };
  shadow: { tokens: Token[] };
  type: { groups: { name: string; styles: TypeStyle[] }[] };
};

const SAMPLE: Record<string, string> = {
  voice: 'Three things moved. One needs you before 2:24.',
  'voice-emphasis': 'One needs you before 2:24.',
  'voice-small': 'Components is at 62 percent.',
  display: 'cypher',
  heading: 'Everyone else is fine.',
  title: 'Mission Control',
  'card-title': 'One rendering with three layouts, or three renderings?',
  section: 'Needs you',
  body: 'Emily is waiting on you. Everything else is on pace.',
  'body-small': "I'd pick one. Say the word.",
  table: 'Rebuild Hero in the Content SDK head',
  meta: 'Aisha Johnson · Discovery · 4 min ago',
  label: 'Decide · Ansell',
  'rail-label': 'Workbench',
  number: '286',
  'number-unit': 'of 1,200',
  button: 'One',
  'button-large': 'Approve the pilot slice',
  nav: 'Site preview',
};

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} className="type-heading">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Swatches({ list }: { list: Token[] }) {
  return (
    <ul className={styles.swatches}>
      {list.map((t) => (
        <li key={t.name} className={styles.swatch}>
          <span className={styles.chip} style={{ background: `var(--${t.name})` }} />
          <span className={styles.tokenText}>
            <span className="type-nav">{t.name}</span>
            <span className="type-meta">{shown(t.value)}</span>
            <span className="type-meta">{t.usage}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Scale({ list, render }: { list: Token[]; render: (t: Token) => React.ReactNode }) {
  return (
    <ul className={styles.scale}>
      {list.map((t) => (
        <li key={t.name} className={styles.scaleRow}>
          {render(t)}
          <span className={styles.tokenText}>
            <span className="type-nav">
              {t.name} <span className={styles.quiet}>{shown(t.value)}</span>
            </span>
            <span className="type-meta">{t.usage}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

const STATES: EyeState[] = ['resting', 'watching', 'needs-a-word'];

export function SystemPage() {
  const [mode, setMode] = useState<'bliss' | 'everything'>('bliss');
  const [blink, setBlink] = useState(0);
  const sizes = T.spacing.tokens.filter((t) => t.name.startsWith('space-'));
  const shell = T.spacing.tokens.filter((t) => !t.name.startsWith('space-'));
  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <Wordmark size={180} />
        <p className="type-voice-small">
          Every token and item the app reads.{' '}
          <em>If it looks wrong here, it is wrong everywhere.</em>
        </p>
        <p className="type-meta">
          From apps/web/src/theme (tokens.json, tokens.css, icons, marks) and apps/web/src/ui.
          Sample copy is the Ansell demo hour.
        </p>
      </header>

      <Section id="color" title="Color">
        <Swatches list={T.color.tokens} />
      </Section>

      <Section id="type" title="Type">
        {T.type.groups.map((g) => (
          <div key={g.name} className={styles.typeGroup}>
            <h3 className="type-label">{g.name}</h3>
            {g.styles.map((s) => (
              <div key={s.name} className={styles.typeRow}>
                <span className={`type-${s.name}`}>{SAMPLE[s.name] ?? s.name}</span>
                <span className="type-meta">
                  {s.name} · {s.fontSize} / {s.lineHeight} / {s.fontWeight}
                  {s.letterSpacing ? `, ${s.letterSpacing}` : ''}
                </span>
              </div>
            ))}
          </div>
        ))}
      </Section>

      <Section id="space" title="Spacing, shell, radius, shadow">
        <Scale
          list={sizes}
          render={(t) => <span className={styles.bar} style={{ width: `var(--${t.name})` }} />}
        />
        <Scale list={shell} render={() => <span className={styles.bar} data-shell />} />
        <Scale
          list={T.radius.tokens}
          render={(t) => (
            <span className={styles.radius} style={{ borderRadius: `var(--${t.name})` }} />
          )}
        />
        <Scale
          list={T.shadow.tokens}
          render={(t) => (
            <span className={styles.shadow} style={{ boxShadow: `var(--${t.name})` }} />
          )}
        />
      </Section>

      <Section id="icons" title="Icons">
        <ul className={styles.icons}>
          {ICON_NAMES.map((n) => (
            <li key={n}>
              <Icon name={n} />
              <Icon name={n} size={22} />
              <span className="type-meta">{n}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="marks" title="Marks and the eye">
        <div className={styles.marks}>
          <figure>
            <EyeResting size={72} />
            <figcaption className="type-meta">eye-resting</figcaption>
          </figure>
          <figure>
            <EyeWatching size={72} />
            <figcaption className="type-meta">eye-watching</figcaption>
          </figure>
          <figure>
            <EyeNeedsAWord size={72} />
            <figcaption className="type-meta">eye-needs-a-word</figcaption>
          </figure>
          <figure className={styles.onInk}>
            <Wordmark size={180} tone="onShell" />
            <figcaption className="type-meta">wordmark, on the shell</figcaption>
          </figure>
        </div>
        <div className={styles.marks}>
          {STATES.map((s) => (
            <figure key={s}>
              <Eye
                state={s}
                size={110}
                halo
                blink={blink > 0 && s === 'needs-a-word'}
                key={`${s}-${blink}`}
              />
              <figcaption className="type-meta">{s}, hero with halo</figcaption>
            </figure>
          ))}
          <figure className={styles.onInk}>
            <span className={styles.row}>
              {STATES.map((s) => (
                <Eye key={s} state={s} size={44} tone="onShell" />
              ))}
            </span>
            <figcaption className="type-meta">in the shell</figcaption>
          </figure>
        </div>
        <button className={`${styles.button} type-button`} onClick={() => setBlink((b) => b + 1)}>
          Blink the eye that needs a word
        </button>
      </Section>

      <Section id="dial" title="Dial (Segmented Control)">
        <div className={styles.row}>
          <SegmentedControl
            kind="toggle"
            aria-label="How much to show"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'bliss', label: 'Bliss' },
              { value: 'everything', label: 'Everything' },
            ]}
          />
          <span className={styles.onInk}>
            <SegmentedControl
              kind="toggle"
              tone="onInk"
              aria-label="How much to show, on ink"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'bliss', label: 'Bliss' },
                { value: 'everything', label: 'Everything' },
              ]}
            />
          </span>
        </div>
      </Section>

      <Section id="recommendation" title="Smart Recommendation (the Yours card's base)">
        <div className={styles.narrow}>
          <SmartRecommendation
            title="Decide · before 2:24"
            options={[
              {
                id: 'one',
                label: 'One rendering',
                reason: (
                  <>
                    <b>I'd pick one.</b> Three layouts on one rendering keep Emily's Hero work and
                    the authoring stays in one place.
                  </>
                ),
                signal: 3,
              },
              {
                id: 'three',
                label: 'Three renderings',
                reason: 'Three renderings mean three templates and a day more for Carlos.',
                signal: 1,
              },
            ]}
          />
        </div>
      </Section>

      <Section id="inbox" title="Decision Inbox (Needs you, Everything)">
        <div className={styles.narrow}>
          <DecisionInbox
            decisions={[
              {
                id: 'slots',
                title: 'Campaign slots: one rendering with three variants, or three renderings',
                detail: 'Aisha Johnson · blocks three tasks · 2 h 42 m, then A',
                primary: 'One',
                secondary: 'Three',
              },
              {
                id: 'vercel',
                title: 'Vercel token for ansell-website expired; preview 7 is queued',
                detail: 'Ryan Mitchell · Samantha waits on it · no clock',
                primary: 'Rotate',
                secondary: 'Later',
              },
              {
                id: 'pilot',
                title: 'Pilot slice proven: Hero, Quick actions and Hazard route edit and publish',
                detail: 'Kevin Nguyen · releases batch three',
                primary: 'Approve',
                secondary: 'Send back',
                collapsed: true,
              },
            ]}
          />
        </div>
      </Section>

      <Section id="toolcall" title="Tool Call Card (Activity rows)">
        <div className={styles.narrow}>
          <ToolCallCard
            name="register_rendering"
            summary="Emily registered Hero in SitecoreAI"
            status="success"
            duration={2140}
            args={{ rendering: 'Hero', site: 'ansell', datasource: 'Data/Hero' }}
            result={{ id: '{8F2C…}', status: 200 }}
          />
          <ToolCallCard
            name="upload_media"
            summary="Thumbnail upload for HazardRoute"
            status="error"
            error="403: the Vercel token for ansell-website expired"
            openOnError
          />
          <ToolCallGroup>
            <ToolCallCard
              name="crawl"
              summary="Read 12 pages of ansell.com"
              status="success"
              duration={8200}
            />
            <ToolCallCard
              name="screenshot"
              summary="Three breakpoints of /products"
              status="success"
              duration={5100}
            />
          </ToolCallGroup>
        </div>
      </Section>

      <Section id="loader" title="Thinking Loader (Cypher at work)">
        <div className={styles.row}>
          <ThinkingLoader
            phases={['Reading the plan', 'Checking with the leads', 'Writing it up']}
            loop
          />
          <ThinkingLoader done doneLabel="Handled" />
        </div>
      </Section>
    </div>
  );
}
