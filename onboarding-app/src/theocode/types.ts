export interface ProjectInfo {
  id: string;
  name: string;
  /** Absolute path of the working directory the agent operates in. */
  path: string;
  createdAt: string;
  /** Set once the setup prompt has been shown, so it never re-prompts. */
  setupPromptedAt?: string;
  /** Closed projects keep their data but leave the workspace tree. */
  closedAt?: string;
}

/** Cheap filesystem detection used to seed the setup prompt. */
export interface SetupDetection {
  /** The directory already had files when the project was added. */
  existing: boolean;
  vercel: boolean;
  supabase: boolean;
}

export interface SetupAnswers {
  vercel: boolean;
  supabase: boolean;
}

export interface SessionMeta {
  id: string;
  projectId: string;
  /** Present on subagent sessions: the agent session that spawned this one. */
  parentSessionId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** The grok CLI's session id, set after the first turn; later turns --resume it. */
  grokSessionId?: string;
}

/** In-flight streaming state for the renderer, replaced by real events on flush. */
export interface TurnPartial {
  thought?: string;
  text?: string;
  tool?: {
    toolName: string;
    command?: string;
    output?: string;
    status?: string;
  };
}

/**
 * One raw record in a session's events.jsonl. The store treats records as
 * opaque JSON aside from the envelope fields; rendering decides later what
 * each `type` looks like.
 */
export interface SessionEvent {
  seq: number;
  at: string;
  type: string;
  [key: string]: unknown;
}

/** Addresses a session (or a subagent session) inside a project. */
export interface SessionRef {
  projectId: string;
  sessionId: string;
  subagentId?: string;
}

export interface SessionNode {
  session: SessionMeta;
  subagents: SessionMeta[];
}

export interface ProjectNode {
  project: ProjectInfo;
  sessions: SessionNode[];
}

export interface WorkspaceTree {
  projects: ProjectNode[];
}

export interface WorkspaceApi {
  getTree(): Promise<WorkspaceTree>;
  /** Opens a directory picker; resolves null if the user cancels. */
  createProject(): Promise<ProjectInfo | null>;
  createSession(projectId: string): Promise<SessionMeta>;
  getEvents(ref: SessionRef): Promise<SessionEvent[]>;
  /** Appends a user message record; the agent turn itself is not wired yet. */
  sendMessage(ref: SessionRef, text: string): Promise<SessionEvent[]>;
  /** Kills the in-flight turn for this session, if any (Escape). */
  interruptTurn(ref: SessionRef): Promise<void>;
  /** Directory entries ("name/" for dirs, dirs first), for List fallback
   *  when the tool result carried no listing text. */
  listDirectory(path: string): Promise<string[]>;
  /** Native context menu for a project tab; resolves true if it closed
   *  the project. */
  projectMenu(projectId: string): Promise<boolean>;
  onEvent(cb: (update: { ref: SessionRef; event: SessionEvent }) => void): void;
  onPartial(
    cb: (update: { ref: SessionRef; partial: TurnPartial | null }) => void,
  ): void;
  /** Filesystem detection for the setup prompt. */
  getSetupInfo(projectId: string): Promise<SetupDetection>;
  /** Starts the setup agent run; resolves with the new session's ref. */
  runSetup(projectId: string, answers: SetupAnswers): Promise<SessionRef>;
  /** Marks the setup prompt as shown (also implied by runSetup). */
  setupSeen(projectId: string): Promise<void>;
}
