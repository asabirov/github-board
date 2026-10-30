import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SignOutNotice } from './SignOutNotice';
import { signOutNotice } from './sign-out-copy';

// The board's test env is `node`, and both shapes this renders are portalled kit
// dialogs, which a server render cannot mount. So the kit is stood in for here
// by plain elements that record the props they were handed: that pins WHICH
// shape each outcome gets and WHAT the guards do, which is our half. The kit's
// half — the real portal, the focus trap, Radix honouring `onEscapeKeyDown` —
// is not tested by this file and was measured in a browser instead.

const kit = vi.hoisted(() => ({ props: {} as Record<string, Record<string, unknown>> }));

vi.mock('../ui/kit', () => {
  const shell = (name: string) =>
    ({ children, ...rest }: { children?: React.ReactNode }) => {
      kit.props[name] = rest as Record<string, unknown>;
      return <div data-kit={name}>{children}</div>;
    };
  return {
    Dialog: shell('Dialog'),
    DialogContent: shell('DialogContent'),
    DialogTitle: shell('DialogTitle'),
    DialogFooter: shell('DialogFooter'),
    AlertDialog: shell('AlertDialog'),
    AlertDialogContent: shell('AlertDialogContent'),
    AlertDialogTitle: shell('AlertDialogTitle'),
    Button: shell('Button'),
  };
});

const SERVER_SENTENCE = 'Signed out of this browser, but connected clients could not be revoked.';
const handlers = () => ({ leave: vi.fn(), retry: vi.fn(), dismiss: vi.fn() });

const UNCONFIRMED_SENTENCE =
  'The sign-out did not reach the board. You may still be signed in, so try again.';

const render = (outcome: Parameters<typeof signOutNotice>[0], h = handlers()) =>
  renderToStaticMarkup(<SignOutNotice notice={signOutNotice(outcome, h)} />);

// The stand-ins above render one <div data-kit="…"> each, so a whole render is
// predictable to the byte. The words on screen are asserted by comparing the
// WHOLE string against one of these, rather than by extracting text out of it:
// no markup is parsed, and this file teaches no strip-tags regex to the next
// person who needs one somewhere it would actually sanitize something.
const box = (kit: string, inner: string) => `<div data-kit="${kit}">${inner}</div>`;
const panel = (shape: 'AlertDialog' | 'Dialog', message: string, action: string) =>
  box(shape, box(`${shape}Content`,
    box(`${shape}Title`, message) + box('DialogFooter', box('Button', action))));

beforeEach(() => { kit.props = {}; });

describe('SignOutNotice (#682)', () => {
  it('renders NOTHING when there is nothing to say — not a byte', () => {
    expect(render({ kind: 'clean' })).toBe('');
    expect(renderToStaticMarkup(<SignOutNotice notice={null} />)).toBe('');
  });

  it('gives a refused revocation the shape with no way out but its button', () => {
    // AlertDialog renders no close X and ignores the scrim by construction; a
    // reflexive Escape on Dialog would finish the redirect and take the one
    // sentence the person has to carry elsewhere with it.
    const markup = render({ kind: 'refused', message: SERVER_SENTENCE });
    expect(markup).toContain('data-kit="AlertDialog"');
    expect(markup).not.toContain('data-kit="Dialog"');
  });

  it('gives an unconfirmed sign-out the shape that closes', () => {
    const markup = render({ kind: 'unconfirmed' });
    expect(markup).toContain('data-kit="Dialog"');
    expect(markup).not.toContain('data-kit="AlertDialog"');
  });

  it('refuses Escape on the one that may not be dismissed', () => {
    render({ kind: 'refused', message: SERVER_SENTENCE });
    const onEscape = kit.props.AlertDialogContent.onEscapeKeyDown as (e: Event) => void;
    const event = { preventDefault: vi.fn() } as unknown as Event;
    onEscape(event);
    expect((event as unknown as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault)
      .toHaveBeenCalledTimes(1);
  });

  it('takes the opening focus itself, because AlertDialog would give it to a Cancel there is none of', () => {
    render({ kind: 'refused', message: SERVER_SENTENCE });
    const onOpen = kit.props.AlertDialogContent.onOpenAutoFocus as (e: Event) => void;
    const event = { preventDefault: vi.fn() } as unknown as Event;
    onOpen(event);
    expect((event as unknown as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault)
      .toHaveBeenCalledTimes(1);
  });

  it('routes a close on the dismissible one through the copy module, and only a close', () => {
    const h = handlers();
    render({ kind: 'unconfirmed' }, h);
    const onOpenChange = kit.props.Dialog.onOpenChange as (open: boolean) => void;
    onOpenChange(true);
    expect(h.dismiss).not.toHaveBeenCalled();
    onOpenChange(false);
    expect(h.dismiss).toHaveBeenCalledTimes(1);
    expect(h.leave).not.toHaveBeenCalled();
  });

  it('says the sentence and the button’s words, and not one word else', () => {
    // The whole render, exactly: a heading, a second sentence explaining the
    // first, or any wrapper carrying words of its own fails here. The message is
    // always somebody else's, and this file writes none.
    expect(render({ kind: 'refused', message: SERVER_SENTENCE }))
      .toBe(panel('AlertDialog', SERVER_SENTENCE, 'Go to sign-in'));
    expect(render({ kind: 'unconfirmed' }))
      .toBe(panel('Dialog', UNCONFIRMED_SENTENCE, 'Try again'));
  });

  it('the assertion above can fail — a heading beside the sentence is caught', () => {
    // The positive control: the same comparison, fed the defect it exists to
    // catch. Without it, an assertion that only ever sees a passing render is a
    // check nobody has watched fail.
    const withHeading = box('AlertDialog', box('AlertDialogContent',
      box('AlertDialogTitle', 'Something went wrong') +
      box('AlertDialogTitle', SERVER_SENTENCE) +
      box('DialogFooter', box('Button', 'Go to sign-in'))));
    const expected = panel('AlertDialog', SERVER_SENTENCE, 'Go to sign-in');
    expect(withHeading).not.toBe(expected);
    expect(render({ kind: 'refused', message: SERVER_SENTENCE })).toBe(expected);
  });

  it('presses through to the copy module’s action, whichever shape it is', () => {
    const h = handlers();
    render({ kind: 'refused', message: SERVER_SENTENCE }, h);
    (kit.props.Button.onClick as () => void)();
    expect(h.leave).toHaveBeenCalledTimes(1);
    const h2 = handlers();
    render({ kind: 'unconfirmed' }, h2);
    (kit.props.Button.onClick as () => void)();
    expect(h2.retry).toHaveBeenCalledTimes(1);
  });
});
