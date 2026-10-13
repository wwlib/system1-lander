// @ts-check
// A mock /v1/systemone for offline UI tests. It replies after about 300 ms and answers every
// question generically: noul → random probability, choice → random option, score → random level.

import http from 'node:http';

const PORT = Number(process.env.PORT) || 11999;

/** @param {any} question */
function mockScore(question) {
  const levelCount = question.criteria.length;
  const score = Math.random() * (levelCount - 1);
  const nearestLevel = Math.round(score);
  /** @type {Record<number, string>} */
  const legend = {};
  /** @type {Record<number, number>} */
  const probabilities = {};
  question.criteria.forEach((/** @type {string} */ description, /** @type {number} */ index) => {
    legend[index] = description;
    probabilities[index] = index === nearestLevel ? 0.8 : 0.2 / (levelCount - 1);
  });
  return { type: 'score', score, legend, probabilities, confidence: 0.7 };
}

/** @param {any} question */
function mockChoice(question) {
  const options = Object.keys(question.criteria);
  const chosen = options[Math.floor(Math.random() * options.length)];
  /** @type {Record<string, number>} */
  const probabilities = {};
  for (const option of options) {
    probabilities[option] = option === chosen ? 0.8 : 0.2 / (options.length - 1);
  }
  return { type: 'choice', choice: chosen, probabilities, confidence: 0.7 };
}

/** @param {any} question */
function mockAnswer(question) {
  if (question.type === 'noul') {
    return { type: 'noul', noul: Math.random() };
  }
  if (question.type === 'score') {
    return mockScore(question);
  }
  return mockChoice(question);
}

const server = http.createServer(async (request, response) => {
  let bodyText = '';
  for await (const chunk of request) {
    bodyText = bodyText + chunk;
  }
  const body = JSON.parse(bodyText);
  /** @type {Record<string, any>} */
  const answers = {};
  for (const [name, question] of Object.entries(body.questions)) {
    answers[name] = mockAnswer(question);
  }
  const reply = {
    model: body.model,
    answers,
    usage: { input_tokens: bodyText.length >> 2, output_tokens: 1 },
  };
  setTimeout(() => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply));
  }, 300);
});
server.listen(PORT);
