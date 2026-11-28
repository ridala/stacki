import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppError } from '../../../shared/core/result';
import {
  buildProjectSetupPrompt,
  type ProjectSetupFinding,
  type ProjectSetupKind,
  type ProjectSetupReport,
  type ProjectSetupSuggestion,
  type WorkspaceAstroApp,
} from '../../../shared/ipc/projectSetup';
import { agentTask } from '../../../shared/properties/agentTask';
import { applyProjectSetup, scanProjectSetup } from '../../ipc/projectSetupBridge';
import { agentTaskHandlerNames, copyAgentPrompt, requestAgentTask } from '../../lib/agentTasks';
import { cleanError } from '../../lib/cleanError';
import { useFormat, useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { holdWindow } from '../../ui/busyLock';
import Dropdown from '../../ui/Dropdown';
import { ErrorToast } from '../../ui/ErrorToast';
import Popup from '../../ui/Popup';
import './projectSetup.css';

interface ProjectSetupBaseProps {
  readonly projectPath: string;
  readonly onClose: () => void;
  readonly showToast?: (message: string, kind: 'success' | 'error' | 'info') => void;
  readonly onPromptSent?: () => void;
}

type ProjectSetupProps = ProjectSetupBaseProps &
  (
    | {
        readonly mode: 'welcome';
        readonly workspaceApps?: readonly WorkspaceAstroApp[];
        readonly onSelectProject?: (projectPath: string) => void;
        readonly onContinue: () => void;
      }
    | { readonly mode: 'settings'; readonly onSaved: () => void }
  );

type SetupScanReason = 'check' | 'stale';

type SetupState =
  | { readonly kind: 'scanning'; readonly reason: SetupScanReason }
  | { readonly kind: 'confirming'; readonly reason: SetupScanReason }
  | { readonly kind: 'scanError'; readonly reason: SetupScanReason; readonly message: AppError }
  | {
      readonly kind: 'review';
      readonly reason: SetupScanReason;
      readonly report: ProjectSetupReport;
      readonly selected: readonly ProjectSetupKind[];
      readonly saveError?: AppError;
    }
  | { readonly kind: 'saving'; readonly report: ProjectSetupReport; readonly selected: readonly ProjectSetupKind[] }
  | { readonly kind: 'saved' }
  | { readonly kind: 'skipped' };

type PromptNotice = { readonly kind: 'status'; readonly message: string } | { readonly kind: 'error'; readonly message: string };

export function ProjectSetupDialog(props: ProjectSetupProps) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const [state, setState] = useState<SetupState>({ kind: 'scanning', reason: 'check' });
  const [promptNotice, setPromptNotice] = useState<PromptNotice | undefined>(undefined);
  const continueButton = useRef<HTMLButtonElement>(null);
  const saving = useRef(false);
  const scanning = state.kind === 'scanning' || state.kind === 'confirming' ? state.reason : undefined;
  const confirming = state.kind === 'confirming';
  const saved = state.kind === 'saved';
  const skipped = state.kind === 'skipped';

  // A native menu command must not open another project while this popup owns the choice.
  useLayoutEffect(holdWindow, []);
  useEffect(() => {
    if (scanning === undefined) {
      return undefined;
    }
    setPromptNotice(undefined);
    let active = true;
    void scanProjectSetup({ projectPath: props.projectPath, ...(confirming ? { permission: 'confirm-open' } : {}) }).then(
      (result) => {
        if (active) {
          setState(
            result.ok
              ? { kind: 'review', reason: scanning, report: result.value, selected: [] }
              : { kind: 'scanError', reason: scanning, message: result.error },
          );
        }
      },
      (failure: unknown) => {
        if (active) {
          setState({ kind: 'scanError', reason: scanning, message: { code: 'transport', message: cleanError(failure) } });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [props.projectPath, scanning, confirming]);
  useEffect(() => {
    if (saved || skipped) {
      continueButton.current?.focus();
    }
  }, [saved, skipped]);

  const select = (kind: ProjectSetupKind): void => {
    setState((current) => {
      if (current.kind !== 'review') {
        return current;
      }
      const selected = current.selected.includes(kind) ? current.selected.filter((item) => item !== kind) : [...current.selected, kind];
      return { ...current, selected };
    });
  };
  const save = async (): Promise<void> => {
    if (state.kind !== 'review' || state.report.settings !== 'editable' || state.selected.length === 0 || saving.current) {
      return;
    }
    const { report, selected } = state;
    // A second press in the same render must not queue another witnessed write.
    saving.current = true;
    setPromptNotice(undefined);
    setState({ kind: 'saving', report, selected });
    const result = await applyProjectSetup({ projectPath: props.projectPath, revision: report.revision, kinds: selected }).catch((failure: unknown) => ({
      ok: false as const,
      error: { code: 'transport', message: cleanError(failure) },
    }));
    saving.current = false;
    if (result.ok) {
      setState({ kind: 'saved' });
      if (props.mode === 'settings') {
        props.onSaved();
      }
      return;
    }
    if (result.error.code === 'stale') {
      // A new revision invalidates the user's previous selections.
      setState({ kind: 'scanning', reason: 'stale' });
      return;
    }
    if (result.error.code === 'unauthorized') {
      setState({ kind: 'scanError', reason: state.reason, message: result.error });
      return;
    }
    setState({ ...state, saveError: result.error });
  };

  const report = state.kind === 'review' || state.kind === 'saving' ? state.report : undefined;
  const canSave = report?.settings === 'editable' && report.suggestions.length > 0;
  const isSaving = state.kind === 'saving';
  const stale = 'reason' in state && state.reason === 'stale';
  const needsPermission = state.kind === 'scanError' && state.message.code === 'unauthorized';
  const canSendToAgent = props.mode === 'settings' && report !== undefined && agentTaskHandlerNames().length > 0;
  const projectName = projectLabel(props.projectPath);
  const copyPrompt = async (): Promise<void> => {
    if (report === undefined) {
      return;
    }
    const prompt = buildProjectSetupPrompt(report, { projectName });
    const outcome = await copyAgentPrompt(prompt);
    if (outcome.tag === 'copied') {
      const message = translate('settings.folders.setup.promptCopied');
      if (props.showToast !== undefined) {
        props.showToast(message, 'success');
      } else {
        setPromptNotice({ kind: 'status', message });
      }
    } else {
      const message = translate('settings.folders.setup.promptFailed', { reason: outcome.message });
      if (props.showToast !== undefined) {
        props.showToast(message, 'error');
      } else {
        setPromptNotice({ kind: 'error', message });
      }
    }
  };
  const sendPrompt = async (finish: (action: () => void) => void): Promise<void> => {
    if (report === undefined) {
      return;
    }
    const prompt = buildProjectSetupPrompt(report, { projectName });
    const files = uniqueFindingFiles(report);
    const outcome = await requestAgentTask(
      agentTask({
        title: translate('settings.folders.setup.title'),
        prompt,
        delivery: 'draft',
        context: { files, nodeRefs: [], findingIds: [] },
      }),
    );
    switch (outcome.tag) {
      case 'sent': {
        const message = translate('settings.folders.setup.promptSent', { where: outcome.where });
        props.showToast?.(message, 'success');
        finish(() => {
          props.onClose();
          props.onPromptSent?.();
        });
        return;
      }
      case 'copied': {
        const message = translate('settings.folders.setup.promptCopied');
        props.showToast?.(message, 'success');
        finish(() => {
          props.onClose();
          props.onPromptSent?.();
        });
        return;
      }
      case 'failed': {
        const message = translate('settings.folders.setup.promptFailed', { reason: outcome.message });
        if (props.showToast !== undefined) {
          props.showToast(message, 'error');
        } else {
          setPromptNotice({ kind: 'error', message });
        }
        return;
      }
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  };
  const setupError = (error: AppError): string => {
    switch (error.code) {
      case 'unauthorized':
        return translate('settings.folders.setup.permission');
      case 'settings-unavailable':
        return translate('settings.folders.setup.unavailable');
      default:
        return translateDescribed(error);
    }
  };
  const title = translate('settings.folders.setup.title');
  const workspaceApps = props.mode === 'welcome' ? props.workspaceApps : undefined;
  const showWorkspacePicker = props.mode === 'welcome' && workspaceApps !== undefined && workspaceApps.length > 1 && props.onSelectProject !== undefined;
  return (
    <Popup className="modal project-setup-dialog" onClose={props.onClose} dismissible={!isSaving && !confirming} label={title}>
      {({ close, finish }) => (
        <>
          <div className="modal-header">{title}</div>
          <div className="modal-body">
            {showWorkspacePicker && (
              <div className="project-setup-workspace-picker">
                <span className="project-setup-workspace-label">{translate('settings.folders.setup.workspaceApp')}</span>
                <Dropdown
                  ariaLabel={translate('settings.folders.setup.workspaceApp')}
                  disabled={isSaving}
                  value={props.projectPath}
                  options={workspaceApps.map((app) => ({
                    value: app.projectPath,
                    label: app.relativePath,
                    hint: app.name,
                  }))}
                  onChange={(nextPath) => {
                    if (nextPath !== props.projectPath) {
                      setPromptNotice(undefined);
                      setState({ kind: 'scanning', reason: 'check' });
                      props.onSelectProject?.(nextPath);
                    }
                  }}
                />
              </div>
            )}
            {stale && <p role="status">{translate('settings.folders.setup.stale')}</p>}
            {scanning !== undefined && <p role="status">{translate('settings.folders.setup.scanning')}</p>}
            {state.kind === 'scanError' && (
              <p role="alert">
                {needsPermission ? setupError(state.message) : translate('settings.folders.setup.scanError', { message: setupError(state.message) })}
              </p>
            )}
            <ErrorToast
              message={
                state.kind === 'review' && state.saveError !== undefined
                  ? translate('settings.folders.setup.saveError', { message: setupError(state.saveError) })
                  : promptNotice?.kind === 'error'
                    ? promptNotice.message
                    : undefined
              }
            />
            {promptNotice?.kind === 'status' && <p role="status">{promptNotice.message}</p>}
            {(state.kind === 'review' || state.kind === 'saving') && (
              <SetupReport report={state.report} selected={state.selected} select={state.kind === 'review' && canSave ? select : undefined} />
            )}
            {saved && (
              <div role="status" className="project-setup-saved">
                <p>{translate('settings.folders.setup.saved')}</p>
                {props.mode === 'settings' && <p>{translate('settings.folders.setup.restartPreview')}</p>}
              </div>
            )}
            {skipped && <p role="status">{translate('settings.folders.setup.skipped')}</p>}
          </div>
          <div className="modal-footer">
            {!saved && (props.mode === 'welcome' || canSave) && (
              <button type="button" onClick={close} disabled={isSaving}>
                {translate('ui.cancel')}
              </button>
            )}
            {report !== undefined && (
              <button type="button" onClick={() => void copyPrompt()} disabled={isSaving}>
                {translate('settings.folders.setup.copyPrompt')}
              </button>
            )}
            {canSendToAgent && (
              <button type="button" onClick={() => void sendPrompt(finish)} disabled={isSaving}>
                {translate('settings.folders.setup.sendToAi')}
              </button>
            )}
            {state.kind === 'scanError' && (!needsPermission || props.mode === 'settings') && (
              <button
                type="button"
                onClick={() => setState({ kind: needsPermission && props.mode === 'settings' ? 'confirming' : 'scanning', reason: state.reason })}
              >
                {translate(needsPermission && props.mode === 'settings' ? 'ui.choose' : 'ui.retry')}
              </button>
            )}
            {props.mode === 'welcome' && (
              <button
                type="button"
                ref={continueButton}
                onClick={() => {
                  if (canSave) {
                    setPromptNotice(undefined);
                    setState({ kind: 'skipped' });
                  } else {
                    finish(props.onContinue);
                  }
                }}
                className={canSave ? undefined : 'primary'}
                disabled={isSaving}
              >
                {translate(canSave ? 'settings.folders.setup.skip' : 'settings.folders.setup.continue')}
              </button>
            )}
            {props.mode === 'settings' && !canSave && (
              <button type="button" ref={continueButton} onClick={close} disabled={confirming} className={needsPermission ? undefined : 'primary'}>
                {translate('ui.close')}
              </button>
            )}
            {canSave && (
              <button
                type="button"
                className="primary"
                disabled={state.kind !== 'review' || state.selected.length === 0}
                aria-busy={isSaving}
                onClick={() => void save()}
              >
                {translate(isSaving ? 'settings.saving' : 'settings.folders.setup.save')}
              </button>
            )}
          </div>
        </>
      )}
    </Popup>
  );
}

function projectLabel(projectPath: string): string {
  const normalized = projectPath.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last !== undefined && last.length > 0 ? last : projectPath;
}

function uniqueFindingFiles(report: ProjectSetupReport): readonly string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const finding of report.findings) {
    for (const file of finding.files) {
      if (!seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  }
  return files;
}

function SetupReport({
  report,
  selected,
  select,
}: {
  readonly report: ProjectSetupReport;
  readonly selected: readonly ProjectSetupKind[];
  readonly select: ((kind: ProjectSetupKind) => void) | undefined;
}) {
  const translate = useTranslate();
  const { formatNumber } = useFormat();
  return (
    <>
      <p>{translate('settings.folders.setup.editors')}</p>
      <div className="project-setup-pages">
        {report.workspaceAppPath !== undefined && <p>{translate('settings.folders.setup.workspaceDetected', { path: report.workspaceAppPath })}</p>}
        <p>
          {translate('settings.folders.pages')} <bdi dir="ltr">{report.pagesFolder}</bdi>
        </p>
        <p>
          {translate('settings.folders.setup.pageCounts', {
            desktop: formatNumber(report.desktopPages),
            studio: formatNumber(report.studioPages),
          })}
        </p>
        {report.pagesSource === 'unverified' && <p>{translate('settings.folders.setup.unverifiedPages')}</p>}
      </div>
      <SetupFindings findings={report.findings} />
      {report.incomplete && <p>{translate('settings.folders.setup.partial')}</p>}
      {report.settings === 'unavailable' && <p>{translate('settings.folders.setup.unavailable')}</p>}
      {report.suggestions.length === 0 && report.settings === 'editable' && !report.incomplete && report.pagesSource !== 'unverified' && (
        <p>{translate('settings.folders.setup.noSuggestions')}</p>
      )}
      {report.suggestions.length > 0 && (
        <>
          {report.settings === 'editable' && <p>{translate('settings.folders.setup.approval')}</p>}
          <table className="project-setup-suggestions">
            <thead>
              <tr>
                <th scope="col">{translate('settings.folders.setup.suggestions')}</th>
                <th scope="col">{translate('settings.folders.setup.desktop')}</th>
                <th scope="col">{translate('settings.folders.setup.studio')}</th>
              </tr>
            </thead>
            <tbody>
              {report.suggestions.map((suggestion) => (
                <SuggestionRow key={suggestion.kind} suggestion={suggestion} selected={selected.includes(suggestion.kind)} select={select} />
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function SetupFindings({ findings }: { readonly findings: readonly ProjectSetupFinding[] }) {
  const translate = useTranslate();
  return (
    <section className="project-setup-findings" aria-label={translate('settings.folders.setup.findingsTitle')}>
      <h3 className="project-setup-section-title">{translate('settings.folders.setup.findingsTitle')}</h3>
      {findings.length === 0 ? (
        <p>{translate('settings.folders.setup.findingsEmpty')}</p>
      ) : (
        <ul className="project-setup-findings-list">
          {findings.map((finding) => (
            <li key={finding.code} className={`project-setup-finding severity-${finding.severity}`}>
              <div className="project-setup-finding-head">
                <span className={`project-setup-badge severity-${finding.severity}`}>{translate(`settings.folders.setup.severity.${finding.severity}`)}</span>
                <span className="project-setup-finding-summary">{finding.summary}</span>
              </div>
              <p className="project-setup-finding-action">{finding.action}</p>
              {finding.files.length > 0 && (
                <p className="project-setup-finding-files">
                  <bdi dir="ltr">{finding.files.join(', ')}</bdi>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SuggestionRow({
  suggestion,
  selected,
  select,
}: {
  readonly suggestion: ProjectSetupSuggestion;
  readonly selected: boolean;
  readonly select: ((kind: ProjectSetupKind) => void) | undefined;
}) {
  const translate = useTranslate();
  const label = translate(`settings.folders.kind.${suggestion.kind}`);
  return (
    <tr>
      <th scope="row">
        <label>
          <input type="checkbox" checked={selected} disabled={select === undefined} onChange={() => select?.(suggestion.kind)} />
          {label}
        </label>
        <ul>
          {suggestion.folders.map((folder) => (
            <li key={folder}>
              <bdi dir="ltr">{folder}</bdi>
            </li>
          ))}
        </ul>
      </th>
      <CatalogChange before={suggestion.desktopBefore} after={suggestion.desktopAfter} added={suggestion.desktopAdded} />
      <CatalogChange before={suggestion.studioBefore} after={suggestion.studioAfter} added={suggestion.studioAdded} removed={suggestion.studioRemoved} />
    </tr>
  );
}

function CatalogChange({
  before,
  after,
  added,
  removed = [],
}: {
  readonly before: number;
  readonly after: number;
  readonly added: readonly string[];
  readonly removed?: readonly string[];
}) {
  const translate = useTranslate();
  const { formatNumber } = useFormat();
  return (
    <td>
      {translate('settings.folders.setup.countChange', { before: formatNumber(before), after: formatNumber(after) })}
      {(added.length > 0 || removed.length > 0) && (
        <ul>
          {added.map((file) => (
            <li key={file}>
              <bdi dir="ltr">+ {file}</bdi>
            </li>
          ))}
          {removed.map((file) => (
            <li key={file}>
              <bdi dir="ltr">− {file}</bdi>
            </li>
          ))}
        </ul>
      )}
    </td>
  );
}
