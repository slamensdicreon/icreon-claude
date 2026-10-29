import type { EscalationView } from '@lw/contracts';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Sprite } from '../../src/lib/icons';
import '../../src/styles/prototype.css';
import bridge from './icreon-affectui.css?inline';
import { GateApproval } from './GateApproval';

/** A gate as the Control API sends it (shape from @lw/contracts). */
const gate: EscalationView = {
  escalationId: 'esc-gate-1',
  type: 'gate',
  title: 'Approve the Blueprint for build',
  context:
    'The Blueprint maps 42 legacy pages onto 18 SitecoreAI components. Build starts once you approve it; the component set is locked after this gate.',
  impact: 'Phase 2 (Build) waits on this. 14 tasks are queued behind it.',
  options: [{ id: 'approve', label: 'Approve', recommended: false, key: null }],
  defaultOptionId: null,
  deadline: null,
  evidence: [
    { kind: 'artifact', ref: 'blueprint', label: 'Blueprint v3' },
    { kind: 'decision', ref: 'D-07', label: 'D-07 Hero variants' },
  ],
  sourceTaskId: null,
  typeLabel: 'Gate 1 · Blueprint sign-off',
  waitNote: 'Waits for you. Discovery continues meanwhile.',
  reversible: false,
  gate: { phase: 1, artifactId: 'blueprint', artifactVersion: 3, requiresConfirmation: true },
  status: 'open',
  raisedAt: new Date().toISOString(),
  deferredUntil: null,
  resolution: null,
  resolvedAt: null,
  undoUntil: null,
};

function Demo() {
  const [themed, setThemed] = useState(true);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [key, setKey] = useState(0);
  document.documentElement.dataset.theme = theme;
  return (
    <main
      style={{ maxWidth: 560, margin: '40px auto', padding: '0 16px', display: 'grid', gap: 16 }}
    >
      <Sprite />
      {themed && <style>{bridge}</style>}
      <h1 style={{ fontSize: 20 }}>Approval Card on the Icreon tokens</h1>
      <div className="btn-row">
        <button className="btn sm" onClick={() => setThemed((t) => !t)}>
          {themed ? 'Show stock affectUI' : 'Show Icreon theme'}
        </button>
        <button className="btn sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
        <button className="btn sm" onClick={() => setKey((k) => k + 1)}>
          Reset
        </button>
      </div>
      <GateApproval
        key={key}
        x={gate}
        about={{ who: 'Priya Raman, Solution Architect', task: 'Compile the Blueprint' }}
        onApprove={() => new Promise((r) => setTimeout(r, 900))}
        onSendBack={() => {}}
        onAsk={() => {}}
      />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Demo />);
