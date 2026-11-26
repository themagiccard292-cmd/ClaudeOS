import clsx from 'clsx';
import { LogOut, Monitor, Moon, MoveHorizontal, Stethoscope, Sun } from 'lucide-react';
import { type RefObject, useId, useRef } from 'react';
import { PANEL_DEFAULT_WIDTH, type PermissionMode, type ThemePreference } from '../../shared/protocol';
import { useDismiss } from '../hooks/useDismiss';
import { api } from '../lib/api';
import { useSettings } from '../state/settings';

export const PERMISSION_OPTIONS: { id: PermissionMode; label: string; hint: string }[] = [
  { id: 'manual', label: 'Ask each time', hint: 'Confirm every edit and command' },
  { id: 'acceptEdits', label: 'Accept edits', hint: 'File edits run; risky actions still ask' },
  { id: 'plan', label: 'Plan mode', hint: 'Claude proposes a plan before acting' },
];

const THEMES: { id: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { id: 'system', label: 'System', Icon: Monitor },
  { id: 'light', label: 'Light', Icon: Sun },
  { id: 'dark', label: 'Dark', Icon: Moon },
];

export interface SettingsPopoverProps {
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  onRunDoctor: () => void;
  onSignedOut: () => void;
  signedIn: boolean;
}

/** Overflow menu from the header: permissions, dock mode, theme, width reset, setup check, sign out. */
export function SettingsPopover({ onClose, anchorRef, onRunDoctor, onSignedOut, signedIn }: SettingsPopoverProps) {
  const { settings, update } = useSettings();
  const ref = useRef<HTMLDivElement>(null);
  const ids = useId();
  useDismiss(true, onClose, ref, anchorRef);

  const resetWidth = async () => {
    const w = await api().panel.setWidth(PANEL_DEFAULT_WIDTH);
    await update({ panelWidth: w });
  };

  const signOut = async () => {
    await api().auth.logout();
    onSignedOut();
    onClose();
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Settings"
      className="animate-fade-up absolute right-2.5 top-11 z-40 max-h-[calc(100vh-4rem)] w-[18.5rem] max-w-[calc(100vw-1.25rem)] overflow-y-auto rounded-xl border border-line bg-surface p-1.5 font-sans shadow-pop"
    >
      <fieldset className="px-1.5 pb-1 pt-1">
        <legend className="mb-1 px-1 text-[11.5px] font-medium text-muted">Permissions</legend>
        {PERMISSION_OPTIONS.map((o) => (
          <label
            key={o.id}
            className="flex cursor-default items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-hover has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent"
          >
            <input
              type="radio"
              name={`${ids}-perm`}
              className="mt-[3px] h-3.5 w-3.5 shrink-0 accent-accent"
              checked={settings.permissionMode === o.id}
              onChange={() => void update({ permissionMode: o.id })}
            />
            <span className="min-w-0">
              <span className="block text-[13px] text-ink">{o.label}</span>
              <span className="block text-[11.5px] leading-snug text-muted">{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="mx-1.5 my-1 border-t border-line" />

      <label className="flex items-center gap-2.5 rounded-lg px-3.5 py-2 transition-colors hover:bg-hover">
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] text-ink">Reserve screen space</span>
          <span className="block text-[11.5px] text-muted">Dock mode: windows make room for the panel</span>
        </span>
        <span className="relative inline-flex shrink-0">
          <input
            type="checkbox"
            role="switch"
            className="peer sr-only"
            checked={settings.reserveSpace}
            onChange={(e) => void update({ reserveSpace: e.target.checked })}
          />
          <span
            aria-hidden
            className="h-5 w-9 rounded-full bg-line transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface"
          />
          <span
            aria-hidden
            className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4"
          />
        </span>
      </label>

      <div className="px-3.5 py-2">
        <div className="mb-1.5 text-[11.5px] font-medium text-muted" id={`${ids}-theme`}>
          Appearance
        </div>
        <div role="radiogroup" aria-labelledby={`${ids}-theme`} className="grid grid-cols-3 gap-0.5 rounded-lg bg-sunken p-0.5">
          {THEMES.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={settings.theme === id}
              onClick={() => void update({ theme: id })}
              className={clsx(
                'flex h-7 items-center justify-center gap-1.5 rounded-md text-[12px] font-medium transition-colors',
                settings.theme === id ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink',
              )}
            >
              <Icon size={13} aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mx-1.5 my-1 border-t border-line" />

      <MenuButton onClick={() => void resetWidth()} Icon={MoveHorizontal}>
        Reset panel width
      </MenuButton>
      <MenuButton
        onClick={() => {
          onRunDoctor();
          onClose();
        }}
        Icon={Stethoscope}
      >
        Run setup check
      </MenuButton>
      {signedIn && (
        <MenuButton onClick={() => void signOut()} Icon={LogOut}>
          Sign out
        </MenuButton>
      )}
      <p className="px-3.5 pb-1 pt-1.5 text-[11px] text-muted">ClaudeOS panel {api().version}</p>
    </div>
  );
}

function MenuButton({ onClick, Icon, children }: { onClick: () => void; Icon: typeof Sun; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-3.5 py-2 text-left text-[13px] text-ink transition-colors hover:bg-hover"
    >
      <Icon size={15} className="text-muted" aria-hidden />
      {children}
    </button>
  );
}
