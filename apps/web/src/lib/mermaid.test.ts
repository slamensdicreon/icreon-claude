import { describe, expect, it } from 'vitest';
import { quotePathLabels } from './mermaid';

describe('quotePathLabels', () => {
  it('quotes route labels in a flowchart', () => {
    expect(quotePathLabels('graph TD\n  H[/ Home] --> A[/about]\n  H --> C[/contact]')).toBe(
      'graph TD\n  H["/ Home"] --> A["/about"]\n  H --> C["/contact"]',
    );
  });

  it('leaves intended shapes, quoted labels and plain labels alone', () => {
    const src =
      'flowchart LR\n  A[/input/] --> B[\\manual\\]\n  B --> C["/quoted"]\n  C --> D[Plain]\n  D --> E[[sub]]';
    expect(quotePathLabels(src)).toBe(src);
  });

  it('leaves other diagram types alone', () => {
    const src = 'sequenceDiagram\n  A->>B: [/x]';
    expect(quotePathLabels(src)).toBe(src);
  });
});
