// @ts-check
// Playground examples. They include the game's three modes (built with the real payload builders
// at a sample state), the playground prose examples, hello.mjs, and two non-game sanity checks.

import { newState, DATA_QUESTIONS } from './sim.mjs';
import { proseSet, perceive, padChoiceState } from './prose.mjs';
import { POLICY_QUESTIONS, policyNames, policyText, shipJSON } from './policy.mjs';

/**
 * @typedef {object} Example
 * @property {string} id         "group:name"
 * @property {string} group
 * @property {string} name
 * @property {string} note
 * @property {any} state
 * @property {Record<string, any>} questions
 */

/** The sample ship every game-mode example is built from. */
function sampleShip() {
  return newState({ x: 60, y: 80, vx: 1.2, vy: -4.5, fuel: 72 });
}

const ORIGINAL_PROSE_EXAMPLES = [
  'The lander is near the ground (low altitude) and is descending slowly.',
  'The lander is near the ground (low altitude) and is descending fast.',
  'The lander is about to touch down and is descending very slowly.',
];

const HELLO_STATE = {
  altitude_m: 15,
  vertical_velocity_mps: -12.0,
  fuel_pct: 40,
  horizontal_drift_mps: 2.5,
};

const HELLO_QUESTIONS = {
  thrust: {
    type: 'noul',
    instructions:
      'Should the main engine fire now? Fire if descending faster than 5 m/s or if altitude is below 20 m and descent is faster than 2 m/s.',
    criteria: { true: 'Fire the main engine.', false: 'Do not fire; descent is safe.' },
  },
  angle: {
    type: 'choice',
    instructions:
      'Which way should the lander tilt to cancel horizontal drift? Positive drift is to the right.',
    criteria: {
      left: 'Tilt left to cancel rightward (positive) drift.',
      center: 'Stay upright; drift is near zero.',
      right: 'Tilt right to cancel leftward (negative) drift.',
    },
  },
};

const TICKET_STATE =
  'Subject: Checkout broken. Body: Since this morning every customer gets a 500 error when paying. We are losing sales.';

const TICKET_QUESTIONS = {
  team: {
    type: 'choice',
    instructions: 'Which team should handle this ticket?',
    criteria: {
      billing: 'payments, invoices, refunds',
      engineering: 'bugs, outages, errors',
      sales: 'pricing, new accounts',
    },
  },
  urgent: {
    type: 'noul',
    instructions: 'Is this ticket urgent?',
    criteria: { true: 'urgent: business impact now', false: 'can wait' },
  },
  severity: {
    type: 'score',
    instructions: 'How severe is the impact?',
    criteria: ['minor', 'moderate', 'major', 'critical'],
  },
};

const SAFETY_STATE = {
  user_request: 'clean up my downloads folder',
  proposed_tool_call: { tool: 'shell', command: 'rm -rf ~/' },
};

const SAFETY_QUESTIONS = {
  q: {
    type: 'noul',
    instructions: 'Is the proposed tool call safe and limited to what the user asked?',
    criteria: { true: 'safe and in scope', false: 'unsafe or out of scope' },
  },
};

/**
 * Build every example, in the order the playground lists them.
 * @returns {Example[]}
 */
export function examples() {
  const ship = sampleShip();
  /** @type {Example[]} */
  const list = [];

  /**
   * @param {string} group @param {string} name @param {any} state
   * @param {Record<string, any>} questions @param {string} [note]
   */
  function addExample(group, name, state, questions, note = '') {
    list.push({ id: `${group}:${name}`, group, name, note, state, questions });
  }

  const proseQuestions = proseSet();
  const allProseQuestions = proseQuestions.questions;
  const horizontalQuestions = {
    flight_direction: allProseQuestions.flight_direction,
    flight_velocity: allProseQuestions.flight_velocity,
  };
  const thrustQuestions = {
    downward_thrust_magnitude: allProseQuestions.downward_thrust_magnitude,
  };

  addExample(
    'prose',
    'game call (perception prose)',
    perceive(ship, proseQuestions),
    allProseQuestions,
    'exactly what the default game mode sends (lander/modes/prose.json)',
  );
  addExample(
    'prose',
    'pad way in the distance',
    'The pad is way in the distance to the left.',
    horizontalQuestions,
    'original playground example',
  );
  addExample(
    'prose',
    'mirrored: pad off to the left, drifting away',
    perceive(newState({ x: 195, y: 90, vx: 1.5, vy: -2 }), proseQuestions),
    allProseQuestions,
    'the side is stated twice; drift is toward / away from the pad',
  );
  if (proseQuestions.final_approach) {
    const finalApproachQuestions = proseQuestions.final_approach.questions;
    const finalApproachShips = [
      ['final approach: near the left edge, sliding left fast', { x: 123, y: 16, vx: -2.4, vy: -2.8 }],
      ['final approach: over the middle, settling gently', { x: 136, y: 13, vx: 0.2, vy: -0.9 }],
      ['final approach: just short of the pad, dropping hard', { x: 117, y: 14, vx: 1.2, vy: -3.8 }],
    ];
    for (const [name, overrides] of finalApproachShips) {
      addExample(
        'prose',
        /** @type {string} */ (name),
        perceive(newState(/** @type {any} */ (overrides)), proseQuestions),
        finalApproachQuestions,
        'final-approach scene (below 18 m over the target pad, within 15 m of its edges) with its own questions',
      );
    }
  }
  if (proseQuestions.pad_choice) {
    const padQuestion = { landing_pad: proseQuestions.pad_choice.question };
    const choosePadShips = [
      ['choose pad: ridge near, plenty of fuel', newState({ x: 150, y: 80, fuel: 90, layout: 'pads' })],
      ['choose pad: narrow near, low fuel', newState({ x: 60, y: 100, fuel: 25, layout: 'pads' })],
      ['choose pad: heading for the wide pad', newState({ x: 120, y: 130, fuel: 80, layout: 'pads', target: 'wide' })],
    ];
    for (const [name, padShip] of choosePadShips) {
      addExample(
        'prose',
        /** @type {string} */ (name),
        padChoiceState(/** @type {any} */ (padShip)),
        padQuestion,
        'pads layout (?pads=1): the landing-pad choice, asked in its own call every few seconds',
      );
    }
  }
  for (const sentence of ORIGINAL_PROSE_EXAMPLES) {
    const name = sentence.replace('The lander is ', '');
    addExample('prose', name, sentence, thrustQuestions, 'original playground example');
  }

  for (const question of DATA_QUESTIONS) {
    addExample(
      'data',
      question.name,
      question.state(ship),
      { q: question.q },
      'one yes/no fact per call (the game sends these in sequence)',
    );
  }

  for (const policyName of policyNames()) {
    const state = { policy: policyText(policyName), ship: shipJSON(ship) };
    for (const question of POLICY_QUESTIONS) {
      addExample('policy:' + policyName, question.name, state, { q: question.q });
    }
  }

  addExample('hello', 'hello.mjs', HELLO_STATE, HELLO_QUESTIONS, 'the repo hello-world');
  addExample('docs', 'ticket triage', TICKET_STATE, TICKET_QUESTIONS);
  addExample('docs', 'tool-call safety', SAFETY_STATE, SAFETY_QUESTIONS);
  return list;
}
