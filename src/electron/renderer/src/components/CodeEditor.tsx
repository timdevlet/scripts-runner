import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, UIEvent } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  applyTab,
  findMatches,
  lineCount,
  scrollEditorToOffset,
  type TextMatch,
} from "../lib/js-editor";
import { tokenizeJs } from "../lib/js-highlight";
import { IconButton, XIcon } from "./IconButton";
import { ChevronDownIcon, MaximizeIcon, RestoreIcon, SearchIcon } from "./icons";
import "./CodeEditor.scss";

type CodeEditorProps = {
  id: string;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
};

const SEED_QUERY_MAX = 200;

// JS source editor: syntax-colored overlay, a line-number gutter on the left, and a maximize
// control that portals the block over the whole app window (the Scripts pane clips overflow, so
// an in-place position:fixed would be cut off — same reason ConfirmPopover portals).
export function CodeEditor({
  id,
  label,
  value,
  onValueChange,
  disabled = false,
  placeholder,
}: CodeEditorProps) {
  const [maximized, setMaximized] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const matchPreRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<{ start: number; end: number; top: number; left: number } | null>(null);
  const tabSelRef = useRef<[number, number] | null>(null);
  const focusFindRef = useRef(false);

  const tokens = useMemo(() => tokenizeJs(value), [value]);
  const matches = useMemo(() => findMatches(value, query), [value, query]);
  const lines = lineCount(value);
  const gutterDigits = Math.max(2, String(lines).length);
  const showFind = maximized || findOpen;
  const currentIndex = matches.length === 0 ? 0 : Math.min(matchIndex, matches.length - 1);

  const syncLayers = (textarea: HTMLTextAreaElement) => {
    const shift = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
    if (preRef.current) preRef.current.style.transform = shift;
    if (matchPreRef.current) matchPreRef.current.style.transform = shift;
    if (gutterRef.current) gutterRef.current.scrollTop = textarea.scrollTop;
  };

  const onScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    syncLayers(e.currentTarget);
  };

  const revealMatch = (index: number, nextMatches: TextMatch[]) => {
    const match = nextMatches[index];
    const el = textareaRef.current;
    if (!match || !el) return;
    el.setSelectionRange(match.start, match.end);
    const pos = scrollEditorToOffset(value, match.start, el.clientHeight, el.clientWidth);
    el.scrollTop = pos.top;
    el.scrollLeft = pos.left;
    syncLayers(el);
  };

  const openFind = () => {
    const el = textareaRef.current;
    if (el && el.selectionStart !== el.selectionEnd) {
      const selected = value.slice(el.selectionStart, el.selectionEnd);
      if (selected.length > 0 && selected.length <= SEED_QUERY_MAX && !selected.includes("\n")) {
        const next = findMatches(value, selected);
        const i = next.findIndex((m) => m.start >= el.selectionStart);
        setQuery(selected);
        setMatchIndex(i === -1 ? 0 : i);
      }
    }
    if (!maximized) setFindOpen(true);
    const input = searchInputRef.current;
    if (input) {
      input.focus();
      input.select();
    } else {
      focusFindRef.current = true;
    }
  };

  const onQueryChange = (nextQuery: string) => {
    setQuery(nextQuery);
    const next = findMatches(value, nextQuery);
    const caret = textareaRef.current?.selectionStart ?? 0;
    const i = next.findIndex((m) => m.start >= caret);
    const index = i === -1 ? 0 : i;
    setMatchIndex(index);
    revealMatch(index, next);
  };

  const goMatch = (delta: number) => {
    if (matches.length === 0) return;
    const next = (currentIndex + delta + matches.length) % matches.length;
    setMatchIndex(next);
    revealMatch(next, matches);
  };

  const toggleMax = () => {
    const el = textareaRef.current;
    if (el) {
      caretRef.current = {
        start: el.selectionStart,
        end: el.selectionEnd,
        top: el.scrollTop,
        left: el.scrollLeft,
      };
    }
    setMaximized((v) => !v);
  };

  // After maximize remounts the textarea in a portal, and after Tab rewrites the value, put the
  // caret and overlay back where they were. No dep list: both of those happen on the render that
  // already committed the new DOM, and reading the refs here is the point.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const caret = caretRef.current;
    if (caret) {
      caretRef.current = null;
      el.selectionStart = caret.start;
      el.selectionEnd = caret.end;
      el.scrollTop = caret.top;
      el.scrollLeft = caret.left;
      if (!focusFindRef.current) el.focus();
    }
    const tabSel = tabSelRef.current;
    if (tabSel) {
      tabSelRef.current = null;
      el.selectionStart = tabSel[0];
      el.selectionEnd = tabSel[1];
    }
    if (focusFindRef.current && searchInputRef.current) {
      focusFindRef.current = false;
      searchInputRef.current.focus();
      searchInputRef.current.select();
    }
    syncLayers(el);
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inEditor = maximized || wrapRef.current?.contains(document.activeElement);
      if (!inEditor) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openFind();
        return;
      }
      if (e.key === "F3" || (mod && e.key.toLowerCase() === "g")) {
        e.preventDefault();
        goMatch(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key !== "Escape") return;
      if (document.activeElement === searchInputRef.current) {
        e.preventDefault();
        textareaRef.current?.focus();
        return;
      }
      if (findOpen && !maximized) {
        e.preventDefault();
        setFindOpen(false);
        textareaRef.current?.focus();
        return;
      }
      if (!maximized) return;
      e.preventDefault();
      const el = textareaRef.current;
      if (el) {
        caretRef.current = {
          start: el.selectionStart,
          end: el.selectionEnd,
          top: el.scrollTop,
          left: el.scrollLeft,
        };
      }
      setMaximized(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized, findOpen, matches, matchIndex, value]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const el = e.currentTarget;
    const next = applyTab(value, el.selectionStart, el.selectionEnd, e.shiftKey);
    tabSelRef.current = [next.start, next.end];
    onValueChange(next.value);
  };

  const findBar = (
    <div className="code-editor-find">
      <div className="code-editor-find-field">
        <span className="code-editor-find-icon" aria-hidden="true">
          <SearchIcon />
        </span>
        <input
          ref={searchInputRef}
          type="text"
          className="code-editor-find-input"
          value={query}
          placeholder="Find"
          spellCheck={false}
          autoComplete="off"
          aria-label="Find in script"
          onChange={(e) => onQueryChange(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              goMatch(e.shiftKey ? -1 : 1);
            }
          }}
        />
      </div>
      <span className="code-editor-find-count" aria-live="polite">
        {query
          ? matches.length === 0
            ? "No results"
            : `${currentIndex + 1}/${matches.length}`
          : ""}
      </span>
      <IconButton
        aria-label="Previous match"
        title="Previous match"
        disabled={matches.length === 0}
        onClick={() => goMatch(-1)}
      >
        <ChevronDownIcon className="code-editor-chevron-up" />
      </IconButton>
      <IconButton
        aria-label="Next match"
        title="Next match"
        disabled={matches.length === 0}
        onClick={() => goMatch(1)}
      >
        <ChevronDownIcon />
      </IconButton>
      {!maximized && (
        <IconButton
          aria-label="Close find"
          title="Close find"
          onClick={() => {
            setFindOpen(false);
            textareaRef.current?.focus();
          }}
        >
          <XIcon />
        </IconButton>
      )}
    </div>
  );

  const editor = (
    <div ref={wrapRef} className={maximized ? "code-editor-wrap maximized" : "code-editor-wrap"}>
      <div className="code-editor-head">
        <label htmlFor={id}>{label}</label>
        {maximized && findBar}
        {!maximized && (
          <IconButton
            aria-label="Find in script"
            title="Find"
            aria-pressed={findOpen}
            onClick={openFind}
          >
            <SearchIcon />
          </IconButton>
        )}
        <IconButton
          aria-label={maximized ? "Restore script editor" : "Maximize script editor"}
          title={maximized ? "Restore" : "Maximize"}
          aria-pressed={maximized}
          onClick={toggleMax}
        >
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </IconButton>
      </div>
      <div className="code-editor">
        {showFind && !maximized && findBar}
        <div className="code-editor-body">
          <div
            className="code-editor-gutter"
            ref={gutterRef}
            aria-hidden="true"
            style={{ "--gutter-ch": `${gutterDigits}ch` } as CSSProperties}
          >
            <pre>{Array.from({ length: lines }, (_, i) => i + 1).join("\n")}</pre>
          </div>
          <div className="code-editor-pane">
            <pre ref={preRef} className="code-editor-highlight" aria-hidden="true">
              {tokens.map((token, i) =>
                token.kind === "text" ? (
                  token.text
                ) : (
                  // Tokens are a stable, append-only parse of one source string — never reordered.
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable, non-reordered token list.
                  <span key={i} className={`js-${token.kind}`}>
                    {token.text}
                  </span>
                ),
              )}
              {"\u200b"}
            </pre>
            {query && matches.length > 0 && (
              <pre ref={matchPreRef} className="code-editor-matches" aria-hidden="true">
                {renderMatchMarks(value, matches, currentIndex)}
                {"\u200b"}
              </pre>
            )}
            <textarea
              ref={textareaRef}
              id={id}
              className="code-editor-input"
              wrap="off"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              placeholder={placeholder}
              value={value}
              disabled={disabled}
              onChange={(e) => onValueChange(e.currentTarget.value)}
              onScroll={onScroll}
              onKeyDown={onKeyDown}
            />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {maximized && <div className="code-editor-slot" aria-hidden="true" />}
      {maximized ? createPortal(editor, document.body) : editor}
    </>
  );
}

function renderMatchMarks(source: string, matches: TextMatch[], current: number) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (match.start > last) parts.push(source.slice(last, match.start));
    parts.push(
      <span key={i} className={i === current ? "js-match current" : "js-match"}>
        {source.slice(match.start, match.end)}
      </span>,
    );
    last = match.end;
  }
  if (last < source.length) parts.push(source.slice(last));
  return parts;
}
