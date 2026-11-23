import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { EventWorkspaceProvider } from "@/contexts/EventWorkspaceContext";
import EventShell from "./components/event/EventShell";
import { WorkspaceGate, JoinWorkspace } from "@/components/event/WorkspaceGate";
import EventWorkspace from "@/pages/EventWorkspace";
import Screen from "@/pages/Screen";
import MerchantTerminal from "@/pages/MerchantTerminal";
import GuestPortal from "@/pages/GuestPortal";
import GuestRegistration from "@/pages/GuestRegistration";
import CheckInDesk from "@/pages/CheckInDesk";
import AccessManagement from "@/pages/AccessManagement";
import ParticipantPortal from "@/pages/ParticipantPortal";
import ParticipantSessionGuard from "@/components/event/ParticipantSessionGuard";
import RoleDemo from "@/pages/RoleDemo";
import "@/styles/event-integration.css";
import "@/styles/consumption.css";
function StaffRoutes() {
  return (
    <EventWorkspaceProvider>
      <Switch>
        <Route path="/join" component={JoinWorkspace} />
        <Route path="/access" component={AccessManagement} />
        <Route path="/screen">
          <WorkspaceGate>
            <Screen />
          </WorkspaceGate>
        </Route>
        <Route path="/merchant">
          <WorkspaceGate>
            <MerchantTerminal />
          </WorkspaceGate>
        </Route>
        <Route path="/checkin">
          <WorkspaceGate>
            <EventShell>
              <CheckInDesk />
            </EventShell>
          </WorkspaceGate>
        </Route>
        {[
          "/",
          "/guests",
          "/seating",
          "/merchants",
          "/settlements",
          "/draw",
          "/settings",
        ].map(path => (
          <Route key={path} path={path}>
            <WorkspaceGate>
              <EventShell>
                <EventWorkspace />
              </EventShell>
            </WorkspaceGate>
          </Route>
        ))}
        <Route component={NotFound} />
      </Switch>
    </EventWorkspaceProvider>
  );
}
export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Switch>
            <Route path="/demo/admin">
              <RoleDemo role="admin" />
            </Route>
            <Route path="/demo/merchant">
              <RoleDemo role="merchant" />
            </Route>
            <Route path="/demo/guest">
              <RoleDemo role="guest" />
            </Route>
            <Route path="/participant" component={ParticipantPortal} />
            <Route path="/guest">
              <ParticipantSessionGuard>
                <GuestPortal />
              </ParticipantSessionGuard>
            </Route>
            <Route path="/register/:slug">
              <ParticipantSessionGuard>
                <GuestRegistration />
              </ParticipantSessionGuard>
            </Route>
            <Route path="/404" component={NotFound} />
            <Route component={StaffRoutes} />
          </Switch>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
