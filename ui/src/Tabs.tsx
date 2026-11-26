import { useEffect, useState } from "react";
import App, { type View } from "./App";
import { hasProject } from "./project";
import { ProjectTab, ProjectTabLabel } from "./ProjectTab";
import { useLiveProject } from "./useLiveBoard";
import type { Project } from "./data/types";

const BOARD_VIEWS: View[] = ["conversation", "home", "mine", "others"]; // "tickets" is hidden for now; add it back with LINEAR_FEED_ENABLED to restore My tickets.
const views = (project: Project | null): View[] => (project && hasProject(project) ? [...BOARD_VIEWS, "project"] : BOARD_VIEWS);
const FOCUS_KINDS = ["ticket", "mypr", "pr", "waiting", "decision"];

type Route = { view: View; focus?: string };

// The hash picks the section (#reviews, #project, ...) or one item in focus mode (#ticket/PROJ-12,
// #pr/app/101). No hash or anything unknown is the Conversation view; #assistant opens Home.
// #tickets and #waiting used to open My tickets, which is hidden for now.
const fromHash = (project: Project | null = null): Route => {
  const h = decodeURIComponent(window.location.hash.slice(1));
  const slash = h.indexOf("/");
  if (slash > 0 && FOCUS_KINDS.includes(h.slice(0, slash)) && h.length > slash + 1) return { view: "focus", focus: h };
  const allowed = views(project);
  // Retired tabs keep their links: Dr. Assistant findings sit on Home; Reviews is part of Others' PRs; #notifications is the sidebar feed. #tickets and #waiting (My tickets) go to Conversation until that tab is restored.
  const name = h === "assistant" ? "home" : h === "reviews" ? "others" : h;
  return { view: allowed.includes(name as View) ? (name as View) : "conversation" };
};

// The page: a left nav with every section, and the selected one (or one focused item) in the main area. The board
// (App) stays mounted across switches, so open composers, typed text and the live feed survive.
export default function Tabs() {
  const project = useLiveProject();
  const [route, setRoute] = useState<Route>(() => fromHash(project));

  // #project is only known once the feed has the project; re-read the hash when it arrives.
  useEffect(() => {
    if (project && hasProject(project) && window.location.hash === "#project") setRoute(fromHash(project));
  }, [project]);

  useEffect(() => {
    const onHash = () => setRoute(fromHash(project));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [project]);

  const select = (next: View) => {
    setRoute({ view: next });
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, "", next === "conversation" ? pathname + search : `#${next}`);
    window.scrollTo?.(0, 0);
  };
  const focus = (f: string) => {
    setRoute({ view: "focus", focus: f });
    window.history.pushState(window.history.state, "", `#${f}`);
    window.scrollTo?.(0, 0);
  };

  return (
    <App
      view={route.view}
      focus={route.focus}
      onSelect={select}
      onFocus={focus}
      project={project && hasProject(project) ? <ProjectTab data={project} /> : undefined}
      projectLabel={project && hasProject(project) ? <ProjectTabLabel data={project} /> : undefined}
    />
  );
}
