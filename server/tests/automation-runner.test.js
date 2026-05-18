jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  renderAutomationStepContent,
} = require('../services/automation-runner');

describe('automation runner rendering', () => {
  test('renders service automation content without newsletter chrome or legal unsubscribe text', () => {
    const rendered = renderAutomationStepContent({
      template: { asm_group: 'service' },
      htmlBody: '<p>Hi {{first_name}}, your estimate is ready.</p>',
      textBody: 'Hi {{first_name}}, your estimate is ready.',
      customer: { first_name: 'Taylor', email: 'taylor@example.com' },
      asmGroupId: 202,
    });

    expect(rendered.html).toContain('Waves');
    expect(rendered.html).toContain('Hi Taylor');
    expect(rendered.html).not.toContain('The Waves Newsletter');
    expect(rendered.html).not.toContain('<%asm_group_unsubscribe_raw_url%>');
    expect(rendered.text).toBe('Hi Taylor, your estimate is ready.');
  });

  test('renders newsletter automation content with newsletter chrome and unsubscribe text', () => {
    const rendered = renderAutomationStepContent({
      template: { asm_group: 'newsletter' },
      htmlBody: '<p>Hi {{first_name}}, here is the newsletter.</p>',
      textBody: 'Hi {{first_name}}, here is the newsletter.',
      customer: { first_name: 'Taylor', email: 'taylor@example.com' },
      asmGroupId: 101,
    });

    expect(rendered.html).toContain('The Waves Newsletter');
    expect(rendered.html).toContain('Hi Taylor');
    expect(rendered.html).toContain('<%asm_group_unsubscribe_raw_url%>');
    expect(rendered.text).toContain('Hi Taylor, here is the newsletter.');
    expect(rendered.text).toContain('Unsubscribe: <%asm_group_unsubscribe_raw_url%>');
  });
});
