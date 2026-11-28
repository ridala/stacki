import { useTranslate } from '../../lib/i18n/useTranslate';
import { ErrorToast } from '../../ui/ErrorToast';
import CloneRepositoryModal from './CloneRepositoryModal';
import WelcomeSplitButton from './WelcomeSplitButton';
import React, { useEffect, useRef, useState } from 'react';
import { chooseSiteFolder, chooseStarterParent, listRecentProjects, refreshRecentThumbnail, removeRecentProject, type RecentProject } from './welcomeBridge';
import { AstroIcon, CloseIcon, ComponentIcon, FolderIcon, GitHubIcon, LayersIcon, LumosIcon } from '../../ui/Icons';
import StackiLogo from './StackiLogo';
import WelcomeShaderBackground from './WelcomeShaderBackground';
import { railScrollbarFor, watchRailEdges } from './recentRail';
import { currentDesktopPlatform } from '../../lib/shortcutLabel';
import { NewProjectWizard, StarterWizard } from './WelcomeWizards';
import ShadcnStarterWizard from './ShadcnStarterWizard';
import HeroUIStarterWizard from './HeroUIStarterWizard';
import { ShadcnStarterLogo } from '../../ui/ShadcnStarterLogo';
import AstroCopyDialog, { announceAstroCopy, type AstroCopySource } from './AstroCopyDialog';
import { FolderDropHost, useFolderChoiceRoute } from './FolderDropHost';
import type { WorkspaceAstroApp } from '../../../shared/ipc/astroCopy';
import Dropdown from '../../ui/Dropdown';
import Popup from '../../ui/Popup';

export interface WelcomeSetupDialogProps {
  readonly projectPath: string;
  readonly workspaceApps?: readonly WorkspaceAstroApp[];
  readonly onSelectProject: (projectPath: string) => void;
  readonly onClose: () => void;
  readonly onContinue: () => void;
}

interface WelcomeSetupTarget {
  readonly projectPath: string;
  readonly workspaceApps?: readonly WorkspaceAstroApp[];
}

interface WelcomeScreenProps {
  readonly onOpen: (projectPath: string) => void;
  /** Opens a newly picked or cloned Astro project and shows Review setup once the editor loads. */
  readonly onOpenWithSetup?: (projectPath: string) => void;
  readonly showToast: (message: string, kind: 'success' | 'error' | 'info') => void;
  readonly renderSetupDialog?: (props: WelcomeSetupDialogProps) => React.ReactNode;
}

const PROJECT_WIZARDS = { astro: NewProjectWizard, lumos: StarterWizard, shadcn: ShadcnStarterWizard, heroui: HeroUIStarterWizard };
type ProjectWizardKind = keyof typeof PROJECT_WIZARDS;
interface ProjectCreation {
  readonly kind: ProjectWizardKind;
  readonly parentPath: string;
}

export default function WelcomeScreen({ onOpen, onOpenWithSetup, showToast }: WelcomeScreenProps) {
  const translate = useTranslate();
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [creation, setCreation] = useState<ProjectCreation | undefined>(undefined);
  const [copySource, setCopySource] = useState<AstroCopySource | undefined>(undefined);
  const [workspaceChoice, setWorkspaceChoice] = useState<WelcomeSetupTarget | undefined>(undefined);
  const recent = useRecentProjects(showToast);
  const openReviewed = onOpenWithSetup ?? onOpen;
  const openPickedTarget = (target: WelcomeSetupTarget): void => {
    if (target.workspaceApps !== undefined && target.workspaceApps.length > 1) {
      setWorkspaceChoice(target);
      return;
    }
    openReviewed(target.projectPath);
  };
  const actions = useWelcomeActions(setError, setCreation, setCopySource, openPickedTarget);
  const ProjectWizard = PROJECT_WIZARDS[creation?.kind ?? 'lumos'];
  // Drop and recent paths open directly. Picked or cloned Astro apps open straight into the editor, then show Review setup.
  const routeFolder = useFolderChoiceRoute({ open: onOpen, offerCopy: setCopySource, showToast });

  return (
    <div className="welcome">
      <WelcomeShaderBackground />
      <WelcomeHero
        hasRecents={recent.projects.length > 0}
        error={error}
        openExisting={() => void actions.openExisting()}
        startProject={(kind) => void actions.startProject(kind)}
        cloneRepository={() => setCloning(true)}
      />
      <RecentRail projects={recent.projects} refreshing={recent.refreshing} open={onOpen} remove={(projectPath) => void recent.remove(projectPath)} />
      <FolderDropHost
        onChoice={(choice) => {
          if (workspaceChoice === undefined) {
            routeFolder(choice);
          }
        }}
        showToast={showToast}
      />
      {workspaceChoice !== undefined && workspaceChoice.workspaceApps !== undefined && (
        <WorkspaceAppChooser
          selectedPath={workspaceChoice.projectPath}
          apps={workspaceChoice.workspaceApps}
          onSelect={(projectPath) => setWorkspaceChoice((current) => (current === undefined ? undefined : { ...current, projectPath }))}
          onClose={() => setWorkspaceChoice(undefined)}
          onOpen={() => {
            const targetPath = workspaceChoice.projectPath;
            setWorkspaceChoice(undefined);
            openReviewed(targetPath);
          }}
        />
      )}
      {cloning && (
        <CloneRepositoryModal
          onClose={() => setCloning(false)}
          onOpen={(target) => {
            setCloning(false);
            openPickedTarget(target);
          }}
        />
      )}
      {copySource && (
        <AstroCopyDialog
          source={copySource}
          onClose={() => setCopySource(undefined)}
          onDone={(created) => {
            setCopySource(undefined);
            announceAstroCopy(created, translate, showToast);
            onOpen(created.projectPath);
          }}
        />
      )}
      {creation && (
        <ProjectWizard
          parentPath={creation.parentPath}
          onClose={() => setCreation(undefined)}
          onDone={(directory) => {
            setCreation(undefined);
            showToast(translate(creation.kind === 'astro' ? 'welcome.projectCreated' : 'welcome.siteCreated'), 'success');
            onOpen(directory);
          }}
        />
      )}
    </div>
  );
}

function useWelcomeActions(
  setError: React.Dispatch<React.SetStateAction<string | undefined>>,
  setCreation: React.Dispatch<React.SetStateAction<ProjectCreation | undefined>>,
  setCopySource: React.Dispatch<React.SetStateAction<AstroCopySource | undefined>>,
  openPickedAstro: (target: WelcomeSetupTarget) => void,
) {
  const translate = useTranslate();
  // An Astro project or monorepo workspace can review its setup; a plain website is offered an Astro copy.
  const openExisting = async (): Promise<void> => {
    setError(undefined);
    const result = await chooseSiteFolder();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const choice = result.value;
    switch (choice.kind) {
      case 'canceled':
        return;
      case 'astro':
        openPickedAstro({ projectPath: choice.projectPath });
        return;
      case 'workspace': {
        const first = choice.apps[0];
        if (first !== undefined) {
          openPickedAstro({ projectPath: first.projectPath, workspaceApps: choice.apps });
        }
        return;
      }
      case 'plainWebsite':
        setCopySource({ sourcePath: choice.sourcePath, parentPath: choice.parentPath, name: choice.name, homePath: choice.homePath });
        return;
      case 'notWebsite':
        setError(translate('welcome.notWebsite'));
        return;
      default: {
        const exhaustive: never = choice;
        return exhaustive;
      }
    }
  };
  // Each wizard names the site's folder after the native picker chooses its parent.
  const startProject = async (kind: ProjectWizardKind): Promise<void> => {
    setError(undefined);
    const result = await chooseStarterParent();
    if (!result.ok) {
      setError(result.error);
    } else if (!result.value.canceled) {
      setCreation({ kind, parentPath: result.value.parentPath });
    }
  };
  return { openExisting, startProject };
}

function useRecentProjects(showToast: WelcomeScreenProps['showToast']) {
  const [projects, setProjects] = useState<readonly RecentProject[]>([]);
  const [queue, setQueue] = useState<readonly RecentProject[]>([]);
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(() => new Set());
  const removedRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let active = true;
    void listRecentProjects().then((result) => {
      if (active && result.ok) {
        setProjects(result.value);
        setQueue(result.value.filter((project) => project.canRefresh && (project.stale || !project.thumb)));
      }
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => refreshQueue(queue, removedRef, setProjects, setRefreshing), [queue]);
  const remove = async (projectPath: string): Promise<void> => {
    const result = await removeRecentProject(projectPath);
    if (!result.ok) {
      showToast(result.error, 'error');
      return;
    }
    removedRef.current = new Set([...removedRef.current, projectPath]);
    setProjects((previous) => previous.filter((project) => project.path !== projectPath));
    setRefreshing((previous) => withoutPath(previous, projectPath));
  };
  return { projects, refreshing, remove };
}

function refreshQueue(
  queue: readonly RecentProject[],
  removedRef: React.MutableRefObject<ReadonlySet<string>>,
  setProjects: React.Dispatch<React.SetStateAction<readonly RecentProject[]>>,
  setRefreshing: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
): () => void {
  let active = true;
  void (async () => {
    for (const project of queue) {
      if (!active) {
        return;
      }
      if (removedRef.current.has(project.path)) {
        continue;
      }
      setRefreshing((previous) => new Set([...previous, project.path]));
      const result = await refreshRecentThumbnail(project.path);
      if (active && result.ok && result.value.ok) {
        setProjects((previous) => updateThumbnail(previous, project.path, result.value));
      }
      if (active) {
        setRefreshing((previous) => withoutPath(previous, project.path));
      }
    }
  })();
  return () => {
    active = false;
  };
}

function updateThumbnail(
  projects: readonly RecentProject[],
  projectPath: string,
  result: { readonly thumb: string | undefined; readonly stale: boolean },
): readonly RecentProject[] {
  return projects.map((project) => (project.path === projectPath ? { ...project, thumb: result.thumb, stale: result.stale } : project));
}

function withoutPath(paths: ReadonlySet<string>, projectPath: string): ReadonlySet<string> {
  const next = new Set(paths);
  next.delete(projectPath);
  return next;
}

function WelcomeHero({
  hasRecents,
  error,
  openExisting,
  startProject,
  cloneRepository,
}: {
  readonly hasRecents: boolean;
  readonly error: string | undefined;
  readonly openExisting: () => void;
  readonly startProject: (kind: ProjectWizardKind) => void;
  readonly cloneRepository: () => void;
}) {
  const translate = useTranslate();
  return (
    <div className="welcome-hero">
      <StackiLogo width={320} className="welcome-logo" />
      <div className="actions">
        <div className="actions-row">
          <WelcomeSplitButton
            className={hasRecents ? 'primary' : ''}
            label={translate('welcome.hero.openFolder')}
            icon={<FolderIcon size={12} />}
            items={[{ label: translate('welcome.hero.openGitHub'), icon: <GitHubIcon size={15} />, onSelect: cloneRepository }]}
            menuTitle={translate('welcome.hero.moreOpen')}
            onClick={openExisting}
          />
          <WelcomeSplitButton
            className={hasRecents ? '' : 'primary'}
            label={translate('welcome.hero.startLumos')}
            icon={<LumosIcon size={15} />}
            items={[
              { label: translate('welcome.hero.startAstro'), icon: <AstroIcon size={15} />, onSelect: () => startProject('astro') },
              { label: translate('welcome.hero.startShadcn'), icon: <ShadcnStarterLogo brand="shadcn" size={15} />, onSelect: () => startProject('shadcn') },
              { label: translate('welcome.hero.startHeroUI'), icon: <ComponentIcon size={15} />, onSelect: () => startProject('heroui') },
            ]}
            menuTitle={translate('welcome.hero.moreStart')}
            onClick={() => startProject('lumos')}
          />
        </div>
      </div>
      {error && <ErrorToast message={error} />}
    </div>
  );
}

function RecentRail({
  projects,
  refreshing,
  open,
  remove,
}: {
  readonly projects: readonly RecentProject[];
  readonly refreshing: ReadonlySet<string>;
  readonly open: (projectPath: string) => void;
  readonly remove: (projectPath: string) => void;
}) {
  const translate = useTranslate();
  if (projects.length === 0) {
    return undefined;
  }
  return (
    <div className="recents">
      <RecentRailScroller>
        {projects.map((project) => (
          <div key={project.path} className="recent-card" title={project.path} onClick={() => open(project.path)}>
            <button
              className="recent-remove"
              title={translate('welcome.recent.remove')}
              onClick={(event) => {
                event.stopPropagation();
                remove(project.path);
              }}
            >
              <CloseIcon size={11} />
            </button>
            <div className={`recent-thumb ${refreshing.has(project.path) ? 'busy' : ''}`}>
              {project.thumb ? <img src={project.thumb} alt="" draggable={false} /> : <LayersIcon size={22} strokeWidth={1.2} />}
            </div>
            <div className="recent-name">{project.name}</div>
            <div className="recent-path">{project.path}</div>
          </div>
        ))}
      </RecentRailScroller>
    </div>
  );
}

function WorkspaceAppChooser({
  selectedPath,
  apps,
  onSelect,
  onClose,
  onOpen,
}: {
  readonly selectedPath: string;
  readonly apps: readonly WorkspaceAstroApp[];
  readonly onSelect: (projectPath: string) => void;
  readonly onClose: () => void;
  readonly onOpen: () => void;
}) {
  const translate = useTranslate();
  const title = translate('settings.folders.setup.workspaceApp');
  return (
    <Popup className="modal" onClose={onClose} label={title}>
      {({ close, finish }) => (
        <>
          <div className="modal-header">{title}</div>
          <div className="modal-body">
            <Dropdown
              ariaLabel={title}
              value={selectedPath}
              options={apps.map((app) => ({
                value: app.projectPath,
                label: app.relativePath,
                hint: app.name,
              }))}
              onChange={onSelect}
            />
          </div>
          <div className="modal-footer">
            <button type="button" onClick={close}>
              {translate('ui.cancel')}
            </button>
            <button type="button" className="primary" onClick={() => finish(onOpen)}>
              {translate('settings.folders.setup.continue')}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}

// The scrolling row itself. It is its own component so the rail element exists
// for exactly as long as the edge watcher that reads it.
function RecentRailScroller({ children }: { readonly children: React.ReactNode }) {
  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rail = railRef.current;
    if (rail === null) {
      return undefined;
    }
    return watchRailEdges(rail, { scrollbar: railScrollbarFor(currentDesktopPlatform()) });
  }, []);
  return (
    <div ref={railRef} className="recent-rail">
      {children}
    </div>
  );
}
