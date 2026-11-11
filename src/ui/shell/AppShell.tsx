import { TabStrip } from './TabStrip';
import { TopBar } from './TopBar';
import { DockArea, LeftRail } from './Dock';
import { StatusBar } from './StatusBar';
import { WorkspaceBody } from './WorkspaceBody';
import { PasswordDialog } from '../common/PasswordDialog';
import { SourcePasswordDialog } from '../common/SourcePasswordDialog';
import { Toasts } from '../common/Toasts';
import { SearchBar } from '../../features/search/SearchBar';
import { ContextMenu } from '../menus/ContextMenu';
import { CommandPalette } from '../palette/CommandPalette';
import { FloatingWindows } from '../floating/FloatingWindows';
import { RecolorFilterDefs } from '../viewer/RecolorFilterDefs';
import { DocumentBars } from '../documents/DocumentBars';
import { CompareBar } from '../documents/CompareBar';
import { CloseDialog } from '../documents/CloseDialog';
import { SideSheet } from '../sheet/SideSheet';
import { SplitSheet } from '../jobs/SplitSheet';
import { CombineWindow } from '../jobs/CombineWindow';
import { MenuBar } from '../menubar/MenuBar';
import { TooltipHost } from '../topbar/Tooltip';
import { HelpDialog } from '../help/HelpDialog';
import { useUiStore } from '../../core/stores/uiStore';

/**
 * The app frame, top to bottom: menu bar (28px), tab strip (36px), top bar (40px, View > Toolbar hides it), body, status
 * bar (24px). The body is the info bars and the find bar over the workspace: left rail, left dock, viewer, right dock, and
 * the page organizer's side sheet on the right. Menus, the palette, floating windows and the dialogs are overlays.
 */
export function AppShell() {
  const toolbarVisible = useUiStore((s) => s.toolbarVisible);
  return (
    <div className="app">
      <MenuBar />
      <TabStrip />
      {toolbarVisible && <TopBar />}
      <div className="app-body">
        <DocumentBars />
        <CompareBar />
        <SearchBar />
        <div className="workspace">
          <LeftRail />
          <DockArea side="left" />
          <main className="main" tabIndex={-1}>
            <WorkspaceBody />
          </main>
          <DockArea side="right" />
          <SideSheet />
          <SplitSheet />
        </div>
      </div>
      <StatusBar />
      <PasswordDialog />
      <CombineWindow />
      <SourcePasswordDialog />
      <CloseDialog />
      <HelpDialog />
      <Toasts />
      <TooltipHost />
      <ContextMenu />
      <CommandPalette />
      <FloatingWindows />
      <RecolorFilterDefs />
    </div>
  );
}
