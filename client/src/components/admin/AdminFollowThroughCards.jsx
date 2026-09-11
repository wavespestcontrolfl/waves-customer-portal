import { Button, Select } from '../ui';
import FollowThroughCards from '../follow-through/FollowThroughCards';

const ui = {
  Card: ({ children }) => <article className="rounded-md border-hairline border-zinc-300 bg-white p-4 space-y-2 text-14 text-ink-primary">{children}</article>,
  Text: ({ children, tone }) => <p className={`text-14 leading-relaxed ${tone === 'alert' ? 'text-alert-fg' : tone === 'muted' ? 'text-ink-secondary' : tone === 'title' ? 'font-medium text-ink-primary' : 'text-ink-primary'}`}>{children}</p>,
  Button: ({ secondary, ...props }) => <Button {...props} variant={secondary ? 'secondary' : 'primary'} className="min-h-11 text-14 normal-case tracking-normal" />,
  Select: (props) => <Select {...props} className="min-h-11 text-14 max-w-full" />,
  Link: (props) => <a {...props} className="inline-flex items-center min-h-11 text-14 underline text-ink-secondary u-focus-ring" />,
};

export default function AdminFollowThroughCards(props) {
  return <FollowThroughCards {...props} ui={ui} />;
}
