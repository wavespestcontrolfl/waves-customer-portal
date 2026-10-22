// Staff preview == public page for the pre-treat notice: a stored
// final-exterior value the server's copy screen fails (named in the detail
// payload's final_exterior_screened_keys) is blanked in the preview too.
import { describe, expect, it } from 'vitest';
import { screenedPreviewFindings } from './ProjectsPage';

describe('screenedPreviewFindings', () => {
  const project = {
    findings: JSON.stringify({ final_exterior_product: 'pet-safe Termidor', final_exterior_active_ingredient: 'Fipronil' }),
    final_exterior_screened_keys: ['final_exterior_product'],
  };

  it('blanks a screened key while the editor still holds the stored value', () => {
    expect(screenedPreviewFindings(project, { final_exterior_product: 'pet-safe Termidor', final_exterior_active_ingredient: 'Fipronil' }))
      .toEqual({ final_exterior_product: '', final_exterior_active_ingredient: 'Fipronil' });
  });

  it('shows a value the editor changed (the save path screens it)', () => {
    expect(screenedPreviewFindings(project, { final_exterior_product: 'Termidor SC' }).final_exterior_product).toBe('Termidor SC');
  });

  it('returns the findings unchanged when nothing is screened', () => {
    const findings = { final_exterior_product: 'Termidor SC' };
    expect(screenedPreviewFindings({ findings: '{}', final_exterior_screened_keys: [] }, findings)).toBe(findings);
  });
});
