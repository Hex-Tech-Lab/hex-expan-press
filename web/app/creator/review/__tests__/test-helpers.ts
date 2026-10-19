import * as React from "react";
import type { ReviewItemView } from "../page";

export const TEST_REVIEW_ITEMS: ReviewItemView[] = [
  {
    id: "item-1",
    code: "Q1",
    kind: "confirm",
    question: "Question 1?",
    options: [
      { key: "A", label: "Option A" },
      { key: "B", label: "Option B" },
    ],
    anchorPage: null,
  },
  {
    id: "item-2",
    code: "Q2",
    kind: "confirm",
    question: "Question 2?",
    options: [
      { key: "X", label: "Option X" },
      { key: "Y", label: "Option Y" },
    ],
    anchorPage: null,
  },
  {
    id: "item-3",
    code: "Q3",
    kind: "confirm",
    question: "Question 3?",
    options: [],
    anchorPage: null,
  },
];

export const STEPPER_FOCUS_ITEMS: ReviewItemView[] = [
  { id: "i1", code: "Q1", kind: "confirm", question: "Question one?", options: [], anchorPage: null },
  { id: "i2", code: "Q2", kind: "confirm", question: "Question two?", options: [], anchorPage: null },
  { id: "i3", code: "Q3", kind: "confirm", question: "Question three?", options: [], anchorPage: null },
];

const MOTION_ONLY_PROPS = [
  "initial",
  "animate",
  "exit",
  "transition",
  "variants",
  "whileTap",
  "whileHover",
  "layout",
];

export function stripMotionProps(props: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(props)) {
    if (!MOTION_ONLY_PROPS.includes(key)) rest[key] = props[key];
  }
  return rest;
}

export function mockFramerMotion() {
  const m = new Proxy(
    {},
    {
      get: (_target, tag) => {
        if (typeof tag !== "string") return undefined;
        return (props: Record<string, unknown>) => React.createElement(tag, stripMotionProps(props));
      },
    },
  );
  return {
    m,
    useReducedMotion: () => true,
    LazyMotion: (props: { children?: React.ReactNode }) => props?.children ?? null,
    domAnimation: {},
  };
}

export function mockNextLink() {
  return {
    default: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
      React.createElement("a", props, props.children),
  };
}
