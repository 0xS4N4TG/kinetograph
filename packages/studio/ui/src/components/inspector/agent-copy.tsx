import { useEffect, useRef, useState } from 'react';
import { CheckIcon, ClipboardCopyIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { copyText } from '@/lib/clipboard';

/** The text box, with the cursor after `Change:` so that the user can type the change at once. */
function MessageBox({ message }: { message: string }) {
  const [text, setText] = useState(message);
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const copy = async () => {
    setState((await copyText(text)) ? 'copied' : 'failed');
  };

  return (
    <>
      <Textarea
        ref={box}
        aria-label="Message for the agent"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setState('idle');
        }}
        rows={9}
        className="max-h-80 font-mono text-xs md:text-xs"
      />
      <DialogFooter className="items-center">
        {state === 'failed' && (
          <span role="status" className="text-destructive mr-auto text-xs">
            Could not copy. Select the text and copy it yourself.
          </span>
        )}
        <Button onClick={copy} size="sm">
          {state === 'copied' ? <CheckIcon /> : <ClipboardCopyIcon />}
          {state === 'copied' ? 'Copied' : 'Copy'}
        </Button>
      </DialogFooter>
    </>
  );
}

/** "Copy for agent": opens the message about the selected layer for the user to finish and copy. */
export function CopyForAgent({ message }: { message: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="h-5 shrink-0 gap-1 rounded-xs px-1.5 text-[10px]"
      >
        <ClipboardCopyIcon className="size-3" />
        Copy for agent
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Copy for agent</DialogTitle>
            <DialogDescription>
              Say what to change after &ldquo;Change:&rdquo;, then copy this and paste it into your coding agent.
            </DialogDescription>
          </DialogHeader>
          <MessageBox message={message} />
        </DialogContent>
      </Dialog>
    </>
  );
}
