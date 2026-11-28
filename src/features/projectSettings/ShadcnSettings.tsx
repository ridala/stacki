import { useEffect, useRef, useState } from 'react';
import { parseShadcnSettingsReply, type ShadcnSettingsChange, type ShadcnSettings as Settings } from '../../../shared/ipc/shadcnSettings';
import { SKILL_FOLDERS } from '../../../shared/properties/instructions';
import { recommendedSkillSource, type ProjectAiToolkit } from '../../../shared/properties/mcp';
import { createRecommendedSkillFile, readProjectAiToolkit } from '../../ipc/aiToolkitBridge';
import { requestShadcnLintSetup } from '../../lib/agentTasks';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { ChevronRightIcon } from '../../ui/Icons';
import { ShadcnStarterLogo } from '../../ui/ShadcnStarterLogo';
import { SwitchRow } from '../../ui/Switch';

interface Props {
  readonly projectPath: string;
  readonly showToast: (message: string, kind?: 'info' | 'success' | 'warning' | 'error') => void;
}

export default function ShadcnSettings({ projectPath, showToast }: Props) {
  const translate = useTranslate();
  const [settings, setSettings] = useState<Settings>();
  const [toolkit, setToolkit] = useState<ProjectAiToolkit>();
  const [pending, setPending] = useState(false);
  const [addingSkill, setAddingSkill] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    if (typeof window.avb.readShadcnSettings === 'function') {
      void window.avb
        .readShadcnSettings({ projectPath })
        .then((reply) => {
          const result = parseShadcnSettingsReply(reply);
          if (current && result.ok) {
            setSettings(result.value);
          }
        })
        .catch(() => {
          if (current) {
            setSettings(undefined);
          }
        });
    }
    void readProjectAiToolkit(projectPath)
      .then((inspected) => {
        if (current) {
          setToolkit(inspected);
        }
      })
      .catch(() => {
        if (current) {
          setToolkit(undefined);
        }
      });
    return () => {
      current = false;
      mounted.current = false;
    };
  }, [projectPath]);

  if (settings === undefined) {
    return undefined;
  }

  const update = async (change: Omit<ShadcnSettingsChange, 'projectPath'>) => {
    setPending(true);
    try {
      const result = parseShadcnSettingsReply(await window.avb.changeShadcnSetting({ projectPath, ...change }));
      if (!mounted.current) {
        return;
      }
      if (result.ok) {
        setSettings(result.value);
      } else {
        showToast(result.error.message, 'error');
      }
    } catch (error: unknown) {
      if (mounted.current) {
        showToast(error instanceof Error ? error.message : String(error), 'error');
      }
    } finally {
      if (mounted.current) {
        setPending(false);
      }
    }
  };

  const shadcnRecommendation = toolkit?.recommendations.find((item) => item.id === 'shadcn');
  const addShadcnSkill = async (): Promise<void> => {
    if (addingSkill) {
      return;
    }
    setAddingSkill(true);
    try {
      const home = SKILL_FOLDERS[0] ?? '.claude/skills';
      const file = `${home}/shadcn/SKILL.md`; // i18n-ignore: a file path, not interface text.
      const source = recommendedSkillSource('shadcn', settings.packagePath === undefined ? {} : { packagePath: settings.packagePath });
      const result = await createRecommendedSkillFile(projectPath, file, source);
      if (!mounted.current) {
        return;
      }
      if (result.ok) {
        showToast(translate('settings.shadcn.skill.added', { name: 'shadcn' }), 'success');
        const refreshed = await readProjectAiToolkit(projectPath);
        if (mounted.current) {
          setToolkit(refreshed);
        }
      } else {
        showToast(result.error.message, 'error');
      }
    } catch (error: unknown) {
      if (mounted.current) {
        showToast(error instanceof Error ? error.message : String(error), 'error');
      }
    } finally {
      if (mounted.current) {
        setAddingSkill(false);
      }
    }
  };

  return (
    <details className="shadcn-project-settings">
      <summary className="list-item settings-link">
        <ShadcnStarterLogo brand="shadcn" size={14} />
        {/* shadcn is the name of the UI library. */}
        <span className="label">shadcn</span>
        <ChevronRightIcon size={14} />
      </summary>
      <div className="shadcn-project-options" aria-busy={pending}>
        {settings.packagePath !== undefined && (
          <p className="shadcn-project-package">{translate('welcome.shadcn.sharedPackage', { path: settings.packagePath })}</p>
        )}
        <SwitchRow
          label={translate('welcome.shadcn.pointer')}
          checked={settings.pointer}
          disabled={pending}
          onToggle={() => void update({ setting: 'pointer', enabled: !settings.pointer })}
        />
        <SwitchRow
          label={translate('welcome.shadcn.rtl')}
          checked={settings.rtl}
          disabled={pending}
          onToggle={() => void update({ setting: 'rtl', enabled: !settings.rtl })}
        />
        {toolkit !== undefined && (
          <>
            <div className="shadcn-project-row">
              <span className="shadcn-project-row-label">{translate('settings.shadcn.skill.label')}</span>
              {shadcnRecommendation?.skillInstalled === true ? (
                <span className="shadcn-project-badge">{translate('settings.shadcn.installed')}</span>
              ) : (
                <button type="button" className="shadcn-project-action" disabled={addingSkill} onClick={() => void addShadcnSkill()}>
                  {translate('settings.shadcn.skill.add')}
                </button>
              )}
            </div>
            <div className="shadcn-project-row">
              {/* @shadcn/lint is the package name of the design-system linter. */}
              <span className="shadcn-project-row-label">@shadcn/lint</span>
              {toolkit.shadcnLint.installed ? (
                <span className="shadcn-project-badge">{translate('settings.shadcn.installed')}</span>
              ) : (
                <button
                  type="button"
                  className="shadcn-project-action"
                  onClick={() => void requestShadcnLintSetup(toolkit.shadcnLint, translate, (message, kind) => showToast(message, kind))}
                >
                  {translate('settings.shadcn.lint.setup')}
                </button>
              )}
            </div>
          </>
        )}
        {pending && <p role="status">{translate('ui.loading')}</p>}
      </div>
    </details>
  );
}
