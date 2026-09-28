import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';

console.log('DATABASE_URL from env:', process.env.DATABASE_URL);

const client = postgres(process.env.DATABASE_URL!);
const db = drizzle(client);

async function main() {
  const schema = await import('../src/db/schema/index.js');
  const { question, answerKey, explanation, rubric, topic } = schema;

  // Find or create the topic (rerunnable seed)
  const existingTopic = await db
    .select({ id: topic.id })
    .from(topic)
    .where(eq(topic.slug, 'basic-arithmetic'))
    .limit(1);

  let topicId: string;
  if (existingTopic.length > 0) {
    topicId = existingTopic[0].id;
    console.log('Reusing topic:', topicId);
  } else {
    const topicResult = await db.insert(topic).values({
      slug: 'basic-arithmetic',
      title: 'Basic Arithmetic',
      parentId: null,
    }).returning({ id: topic.id });
    topicId = topicResult[0].id;
    console.log('Created topic:', topicId);
  }

  // Create questions with different difficulties
  const questions = [
    { text: 'What is 2+2?', options: ['3','4','5','6'], correct: 1, difficulty: 1 },
    { text: 'What is 5*3?', options: ['12','15','18','20'], correct: 1, difficulty: 1 },
    { text: 'What is 10-4?', options: ['4','5','6','7'], correct: 2, difficulty: 1 },
    { text: 'What is 8/2?', options: ['2','3','4','5'], correct: 2, difficulty: 2 },
    { text: 'What is 7+6?', options: ['11','12','13','14'], correct: 2, difficulty: 2 },
    { text: 'What is 9*2?', options: ['16','17','18','19'], correct: 2, difficulty: 2 },
    { text: 'What is 15-8?', options: ['5','6','7','8'], correct: 2, difficulty: 3 },
    { text: 'What is 12/3?', options: ['3','4','5','6'], correct: 1, difficulty: 3 },
    { text: 'What is 6*7?', options: ['40','41','42','43'], correct: 2, difficulty: 3 },
  ];

  for (const q of questions) {
    const qResult = await db.insert(question).values({
      topicId,
      type: 'multiple_choice',
      status: 'published',
      text: q.text,
      contentBlocks: [{ type: 'text', content: q.text }],
      options: q.options.map((opt, idx) => ({ index: idx, text: opt })),
      subject: 'Math',
      concepts: [],
      prerequisites: [],
      hasTrap: false,
      difficultyAi: q.difficulty,
    }).returning({ id: question.id, version: question.version });

    const qId = qResult[0].id;
    const qVersion = qResult[0].version;

    await db.insert(answerKey).values({
      questionId: qId,
      questionVersion: qVersion,
      correctOptionIndex: q.correct,
      correctText: null,
    });

    await db.insert(explanation).values({
      questionId: qId,
      questionVersion: qVersion,
      origin: 'official',
      body: 'This is a basic arithmetic question.',
    });

    console.log('Created question:', qId);
  }

  // Descriptive (free-text essay) questions with rubric parts
  const descriptive = [
    {
      text: 'Explain why 2+2 equals 4 using number line reasoning.',
      expectedAnswer: 'Starting at 2 on the number line and moving 2 units forward lands on 4.',
      difficulty: 1,
      rubricParts: [
        { partKey: 'number_line_setup', maxScore: '0.50', order: 0 },
        { partKey: 'final_result', maxScore: '0.50', order: 1 },
      ],
    },
    {
      text: 'Solve 3x + 5 = 20 and show each step of your work.',
      expectedAnswer: 'x = 5',
      difficulty: 2,
      rubricParts: [
        { partKey: 'isolate_variable', maxScore: '0.50', order: 0 },
        { partKey: 'correct_steps', maxScore: '0.25', order: 1 },
        { partKey: 'final_answer', maxScore: '0.25', order: 2 },
      ],
    },
    {
      text: 'Prove that the sum of two even numbers is always even.',
      expectedAnswer: 'An even number is 2k for some integer k, so 2a + 2b = 2(a+b), which is even.',
      difficulty: 3,
      rubricParts: [
        { partKey: 'definition_of_even', maxScore: '0.25', order: 0 },
        { partKey: 'algebraic_argument', maxScore: '0.50', order: 1 },
        { partKey: 'conclusion', maxScore: '0.25', order: 2 },
      ],
    },
  ];

  for (const q of descriptive) {
    const qResult = await db.insert(question).values({
      topicId,
      type: 'descriptive',
      status: 'published',
      text: q.text,
      contentBlocks: [{ type: 'text', content: q.text }],
      options: [],
      subject: 'Math',
      concepts: [],
      prerequisites: [],
      hasTrap: false,
      difficultyAi: q.difficulty,
    }).returning({ id: question.id, version: question.version });

    const qId = qResult[0].id;
    const qVersion = qResult[0].version;

    await db.insert(answerKey).values({
      questionId: qId,
      questionVersion: qVersion,
      correctOptionIndex: null,
      correctText: q.expectedAnswer,
    });

    await db.insert(explanation).values({
      questionId: qId,
      questionVersion: qVersion,
      origin: 'official',
      body: 'Expected answer: ' + q.expectedAnswer,
    });

    for (const part of q.rubricParts) {
      await db.insert(rubric).values({
        questionId: qId,
        partKey: part.partKey,
        maxScore: part.maxScore,
        order: part.order,
      });
    }

    console.log('Created descriptive question:', qId);
  }

  // Verify
  const rows = await db.select().from(question).where(eq(question.status, 'published'));
  console.log('Total published questions:', rows.length);
  rows.forEach(q => console.log(' -', q.id, q.text, 'difficulty:', q.difficultyAi));

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});