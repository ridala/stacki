import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { err, ok } from '../../shared/core/result';
import { WORKSPACE_ASTRO_APPS_MAX } from '../../shared/ipc/projectSetup';
import { applyProjectSetup, scanProjectSetup, staleProjectSetup } from '../project/projectSetup';
import { isAstroProject } from '../project/projectFiles';
import { translateMain } from '../lib/mainLocale';
import type { MainHost } from './mainHost';
import { announceFolderChange } from './projectMetadataHandlers';

const PICKER_GRANT_MS = 5 * 60_000;

interface ProjectIdentity {
  readonly path: string;
  readonly canonical: string;
  readonly device: number;
  readonly inode: number;
}

/** One native selection can become the active project. Renderer-supplied watch and scan paths carry no grant. */
export function createProjectSetupAccess(now: () => number = Date.now) {
  let active: ProjectIdentity | undefined;
  let pending: { readonly projects: readonly ProjectIdentity[]; readonly expires: number } | undefined;
  let review: { readonly project: ProjectIdentity; readonly revision: string } | undefined;
  let picker: object | undefined;

  function pendingProjects(): readonly ProjectIdentity[] {
    if (pending !== undefined && now() < pending.expires) {
      return pending.projects;
    }
    pending = undefined;
    return [];
  }

  function matchPending(requested: string | undefined): ProjectIdentity | undefined {
    for (const candidate of pendingProjects()) {
      const matched = matchingProject(candidate, requested);
      if (matched !== undefined) {
        return matched;
      }
    }
    return undefined;
  }

  function grantPicked(selection: object, selectedPaths: readonly string[]): void {
    if (selection !== picker) {
      return;
    }
    picker = undefined;
    const projects: ProjectIdentity[] = [];
    for (const selectedPath of selectedPaths.slice(0, WORKSPACE_ASTRO_APPS_MAX)) {
      const project = projectIdentity(selectedPath);
      if (project !== undefined) {
        projects.push(project);
      }
    }
    if (projects.length > 0) {
      pending = { projects, expires: now() + PICKER_GRANT_MS };
    }
  }

  return {
    beginPicker() {
      const selection = {};
      picker = selection;
      pending = undefined;
      return selection;
    },
    acceptPicker(selection: object, selectedPath: string) {
      grantPicked(selection, [selectedPath]);
    },
    acceptPickerPaths(selection: object, selectedPaths: readonly string[]) {
      grantPicked(selection, selectedPaths);
    },
    confirmOpen(selection: object, openPath: string, selectedPath: string) {
      if (selection !== picker) {
        return;
      }
      picker = undefined;
      const project = projectIdentity(selectedPath);
      if (project === undefined || matchingProject({ ...project, path: openPath }, openPath) === undefined) {
        return;
      }
      if (isAstroProject(project.canonical)) {
        active = { ...project, path: openPath };
        review = undefined;
      }
    },
    activate(projectPath: string | undefined) {
      if (matchingProject(active, projectPath) !== undefined) {
        return;
      }
      active = matchPending(projectPath);
      if (active !== undefined) {
        pending = undefined;
      }
      review = undefined;
    },
    resetView() {
      pending = undefined;
      picker = undefined;
      review = undefined;
    },
    authorize(projectPath: string, openProject: string | undefined) {
      return matchingProject(matchingProject(active, openProject), projectPath) ?? matchPending(projectPath);
    },
    remember(project: ProjectIdentity, revision: string) {
      review = { project, revision };
    },
    reviewed(project: ProjectIdentity, revision: string) {
      return review?.project === project && review.revision === revision;
    },
  };
}

export type ProjectSetupAccess = ReturnType<typeof createProjectSetupAccess>;
export type IsSetupFrame = (event: IpcMainInvokeEvent) => boolean;

export function registerProjectSetupHandlers(
  host: Pick<MainHost, 'ipcMain' | 'send' | 'openProject' | 'showOpenDialog'>,
  access: ProjectSetupAccess,
  isSetupFrame: IsSetupFrame,
): void {
  const authorized = (event: IpcMainInvokeEvent, projectPath: string) => (isSetupFrame(event) ? access.authorize(projectPath, host.openProject()) : undefined);
  // i18n-ignore: The setup UI translates this stable error code.
  const refused = err({ code: 'unauthorized', message: 'Choose this Astro project with the native folder picker before using setup.' });

  host.ipcMain.handle('project:setupScan', async (event, { projectPath, permission }) => {
    if (!isSetupFrame(event)) {
      return refused;
    }
    if (permission === 'confirm-open') {
      if (projectPath !== host.openProject()) {
        return refused;
      }
      const selection = access.beginPicker();
      const picked = await host.showOpenDialog({
        title: translateMain('dialog.open.project.title'),
        defaultPath: projectPath,
        properties: ['openDirectory'],
      });
      const selectedPath = picked.filePaths[0];
      if (picked.canceled || selectedPath === undefined || !isSetupFrame(event) || projectPath !== host.openProject()) {
        return refused;
      }
      access.confirmOpen(selection, projectPath, selectedPath);
    }
    const project = authorized(event, projectPath);
    if (project === undefined) {
      return refused;
    }
    const report = scanProjectSetup(project.canonical);
    access.remember(project, report.revision);
    return ok(report);
  });
  host.ipcMain.handle('project:setupApply', (event, request) => {
    const project = authorized(event, request.projectPath);
    if (project === undefined) {
      return refused;
    }
    if (!access.reviewed(project, request.revision)) {
      return staleProjectSetup();
    }
    const applied = applyProjectSetup(project.canonical, request, () => announceFolderChange(host.send));
    if (applied.ok) {
      access.remember(project, applied.value.revision);
    }
    return applied;
  });
}

function projectIdentity(selectedPath: string): ProjectIdentity | undefined {
  try {
    const canonical = fs.realpathSync(selectedPath);
    const stat = fs.statSync(canonical);
    if (stat.isDirectory()) {
      return { path: path.resolve(selectedPath), canonical, device: stat.dev, inode: stat.ino };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function matchingProject(project: ProjectIdentity | undefined, requested: string | undefined): ProjectIdentity | undefined {
  if (project === undefined || (requested !== project.path && requested !== project.canonical)) {
    return undefined;
  }
  // Check only a path named by the OS. A replacement directory cannot inherit a granted identity.
  const current = projectIdentity(requested);
  if (current?.canonical === project.canonical && current.device === project.device && current.inode === project.inode) {
    return project;
  }
  return undefined;
}
