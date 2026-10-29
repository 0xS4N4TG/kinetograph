import { useCallback, useEffect, useId, useState } from 'react';
import { BookmarkIcon, ChevronDownIcon } from 'lucide-react';

import type { CompositionInfo, PresetInfo, StudioApi } from '@/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** As the server's rule for a preset name. */
const NAME = /^[a-z0-9][a-z0-9-_]{0,63}$/;

interface PresetsMenuProps {
  api: StudioApi;
  comp: CompositionInfo;
  values: Record<string, unknown>;
  onLoad(props: Record<string, unknown>): void;
}

/** The Props tab's preset controls: a menu that loads a saved preset, and a button that saves the current props. */
export function PresetsMenu({ api, comp, values, onLoad }: PresetsMenuProps) {
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();

  const refresh = useCallback(() => {
    api.presets(comp.id).then(setPresets, () => setPresets([]));
  }, [api, comp.id]);
  useEffect(refresh, [refresh]);

  const valid = NAME.test(name);
  const save = () => {
    api.savePreset(comp.id, name, values).then(
      () => {
        setSaving(false);
        refresh();
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" data-testid="presets-menu">
            Presets
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {presets.length === 0 ? (
            <div className="text-muted-foreground px-2 py-1.5 text-sm">No presets saved</div>
          ) : (
            presets.map((preset) => (
              <DropdownMenuItem key={preset.name} onSelect={() => onLoad({ ...comp.defaultProps, ...preset.props })}>
                {preset.name}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setName('');
          setError(null);
          setSaving(true);
        }}
      >
        <BookmarkIcon />
        Save preset
      </Button>
      <Dialog open={saving} onOpenChange={setSaving}>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) save();
            }}
          >
            <DialogHeader>
              <DialogTitle>Save preset</DialogTitle>
              <DialogDescription>
                Writes the current props to presets/{comp.id}/{name || 'name'}
                .json beside the entry.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={nameId}>Name</Label>
              <Input
                id={nameId}
                autoFocus
                value={name}
                aria-invalid={name !== '' && !valid}
                onChange={(event) => setName(event.target.value)}
              />
              <p className={name !== '' && !valid ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
                Lower-case letters, digits, - and _; up to 64 characters.
              </p>
              {error !== null && <p className="text-destructive text-xs">{error}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setSaving(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!valid}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
