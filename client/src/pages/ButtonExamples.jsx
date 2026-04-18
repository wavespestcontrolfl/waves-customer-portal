// Visual QA harness for the shared <Button /> primitive.
// Route: /button-examples — not linked from anywhere, safe to delete once migration is done.

import React from 'react';
import { Button } from '../components/Button';

const variants = ['primary', 'secondary', 'tertiary', 'nav', 'utility'];

function Row({ surface, bg }) {
  return (
    <section style={{ background: bg, padding: '32px 24px', borderRadius: 12 }}>
      <h2 style={{
        margin: '0 0 16px',
        fontFamily: "'Montserrat', 'Inter', sans-serif",
        fontSize: 18,
        fontWeight: 700,
        color: surface === 'admin' ? '#e2e8f0' : '#1B2C5B',
      }}>
        surface = "{surface}"
      </h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        {variants.map((v) => (
          <Button key={v} variant={v} surface={surface}>
            {v}
          </Button>
        ))}
        <Button variant="primary" surface={surface} icon="→">
          With icon
        </Button>
        <Button variant="primary" surface={surface} disabled>
          Disabled
        </Button>
      </div>
      <div style={{ marginTop: 16 }}>
        <Button variant="primary" surface={surface} fullWidthMobile icon="→">
          Full-width on mobile
        </Button>
      </div>
      <div style={{ marginTop: 12 }}>
        <Button variant="secondary" surface={surface} as="a" href="#test">
          As anchor tag
        </Button>
      </div>
    </section>
  );
}

export default function ButtonExamples() {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#F1F5F9',
      padding: 24,
      fontFamily: "'Inter', system-ui, sans-serif",
    }}>
      <h1 style={{
        margin: '0 0 24px',
        fontFamily: "'Anton', 'Luckiest Guy', cursive",
        fontSize: 36,
        color: '#1B2C5B',
        letterSpacing: '0.02em',
      }}>
        Button system — visual QA
      </h1>
      <div style={{ display: 'grid', gap: 20 }}>
        <Row surface="customer" bg="#FFFFFF" />
        <Row surface="admin" bg="#0f1923" />
      </div>
    </div>
  );
}
