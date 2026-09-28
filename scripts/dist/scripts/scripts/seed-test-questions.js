"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const postgres_1 = __importDefault(require("postgres"));
const postgres_js_1 = require("drizzle-orm/postgres-js");
const drizzle_orm_1 = require("drizzle-orm");
console.log('DATABASE_URL from env:', process.env.DATABASE_URL);
const client = (0, postgres_1.default)(process.env.DATABASE_URL);
const db = (0, postgres_js_1.drizzle)(client);
async function main() {
    const schema = await Promise.resolve().then(() => __importStar(require('../src/db/schema/index.js')));
    const { question, answerKey, explanation, topic } = schema;
    // Create a topic
    const topicResult = await db.insert(topic).values({
        slug: 'basic-arithmetic',
        title: 'Basic Arithmetic',
        parentId: null,
    }).returning({ id: topic.id });
    const topicId = topicResult[0].id;
    console.log('Created topic:', topicId);
    // Create questions with different difficulties
    const questions = [
        { text: 'What is 2+2?', options: ['3', '4', '5', '6'], correct: 1, difficulty: 1 },
        { text: 'What is 5*3?', options: ['12', '15', '18', '20'], correct: 1, difficulty: 1 },
        { text: 'What is 10-4?', options: ['4', '5', '6', '7'], correct: 2, difficulty: 1 },
        { text: 'What is 8/2?', options: ['2', '3', '4', '5'], correct: 2, difficulty: 2 },
        { text: 'What is 7+6?', options: ['11', '12', '13', '14'], correct: 2, difficulty: 2 },
        { text: 'What is 9*2?', options: ['16', '17', '18', '19'], correct: 2, difficulty: 2 },
        { text: 'What is 15-8?', options: ['5', '6', '7', '8'], correct: 2, difficulty: 3 },
        { text: 'What is 12/3?', options: ['3', '4', '5', '6'], correct: 1, difficulty: 3 },
        { text: 'What is 6*7?', options: ['40', '41', '42', '43'], correct: 2, difficulty: 3 },
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
    // Verify
    const rows = await db.select().from(question).where((0, drizzle_orm_1.eq)(question.status, 'published'));
    console.log('Total published questions:', rows.length);
    rows.forEach(q => console.log(' -', q.id, q.text, 'difficulty:', q.difficultyAi));
    process.exit(0);
}
main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
