import '../config/env.js';

const DIFY_API_URL = process.env.DIFY_API_URL || 'https://api.dify.ai/v1/chat-messages';
const DIFY_API_KEY = process.env.DIFY_API_KEY;

/**
 * Clean and format Dify questions to match Mongoose schemas perfectly.
 */
export const sanitizeDifyQuestions = (questions) => {
  if (!Array.isArray(questions)) return [];

  return questions.map((q) => {
    let type = q.type || 'Short';
    let correctAnswer = q.correctAnswer;
    let options = q.options || [];
    const topic = q.topic || 'General';

    // 1. Map Dify custom Coding type to Scenario (supported by Mongoose and Frontend text box)
    if (type === 'Coding') {
      type = 'Scenario';
    }

    // 2. If the question has options, it must be MCQ or MSQ
    if (options.length > 0) {
      const isMultiSelect = Array.isArray(correctAnswer) && correctAnswer.length > 1;

      // Map Scenario/Logical questions with options to MCQ or MSQ
      if (['Scenario', 'Logical', 'Analytical', 'Short', 'Long'].includes(type)) {
        type = isMultiSelect ? 'MSQ' : 'MCQ';
      }

      // If MCQ, correctAnswer must be a string, not an array
      if (type === 'MCQ') {
        if (Array.isArray(correctAnswer)) {
          correctAnswer = correctAnswer[0] || '';
        }
      } else if (type === 'MSQ') {
        if (!Array.isArray(correctAnswer)) {
          correctAnswer = [correctAnswer].filter(Boolean);
        }
      }
    } else {
      // 3. Descriptive questions (Short, Long, Scenario without options)
      // If type is MCQ/MSQ but there are no options, map it to Short to prevent candidate getting stuck
      if (['MCQ', 'MSQ'].includes(type)) {
        type = 'Short';
      }
      options = [];
      if (Array.isArray(correctAnswer)) {
        correctAnswer = correctAnswer.join('\n');
      }
    }

    // 4. Fallback default timer durations if missing or invalid
    let timerDuration = Number(q.timerDuration);
    if (!timerDuration || isNaN(timerDuration)) {
      if (type === 'MCQ') timerDuration = 30;
      else if (type === 'MSQ') timerDuration = 45;
      else if (type === 'Short') timerDuration = 90;
      else if (['Logical', 'Analytical'].includes(type)) timerDuration = 120;
      else if (type === 'Scenario' && (topic.toLowerCase().includes('coding') || topic.toLowerCase().includes('integration'))) timerDuration = 300;
      else timerDuration = 240;
    }

    return {
      text: q.text || '',
      type,
      options,
      correctAnswer,
      timerDuration,
      topic,
    };
  });
};

/**
 * Generate questions using the Dify Knowledge Base chat-messages API.
 */
export const generateDifyQuestions = async (personaMarkdown, count) => {
  if (!DIFY_API_KEY) {
    console.warn('WARNING: DIFY_API_KEY is not defined. Skipping Dify integration.');
    return [];
  }

  try {
    console.log(`Calling Dify Chat API to generate ${count} questions...`);

    const payload = {
      inputs: {
        persona: personaMarkdown,
        count: String(count),
      },
      query: 'Generate Cortex Questions',
      response_mode: 'blocking',
      user: 'assessment-agent',
    };

    const response = await fetch(DIFY_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DIFY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Dify API request failed with status ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const answerText = data.answer;

    if (!answerText) {
      throw new Error('Dify API returned an empty answer.');
    }

    // Extract JSON block from markdown if wrapped in ```json ... ```
    let cleanJson = answerText;
    const jsonBlockRegex = /```json([\s\S]*?)```/;
    const match = answerText.match(jsonBlockRegex);
    if (match && match[1]) {
      cleanJson = match[1].trim();
    } else {
      // In case Dify outputs ``` (without json language tag)
      const genericBlockRegex = /```([\s\S]*?)```/;
      const genericMatch = answerText.match(genericBlockRegex);
      if (genericMatch && genericMatch[1]) {
        cleanJson = genericMatch[1].trim();
      }
    }

    // Attempt to parse JSON
    const parsedData = JSON.parse(cleanJson.trim());
    const rawQuestions = parsedData.questions || [];

    console.log(`Dify returned ${rawQuestions.length} raw questions.`);
    const sanitized = sanitizeDifyQuestions(rawQuestions);
    console.log(`Successfully sanitized ${sanitized.length} Dify questions.`);

    return sanitized;
  } catch (error) {
    console.error('Error generating questions from Dify API:', error);
    // Return empty array to trigger fallback gracefully
    return [];
  }
};
