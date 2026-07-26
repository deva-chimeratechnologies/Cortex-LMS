import Assessment from '../models/Assessment.js';
import Question from '../models/Question.js';
import Answer from '../models/Answer.js';
import CheatingLog from '../models/CheatingLog.js';
import Certificate from '../models/Certificate.js';
import Report from '../models/Report.js';
import { generateQuestions, evaluateTextAnswer, determinePersonaRoleAndLevel } from '../services/groq.service.js';
import { compileAssessmentReport } from '../services/report.service.js';
import crypto from 'crypto';

// @desc    Start a new assessment
// @route   POST /api/assessments/start
// @access  Private
export const startAssessment = async (req, res, next) => {
  try {
    const { name, employeeId, department, jobRole, experience, skills, certificationLevel } = req.body;

    if (!name || !department || !jobRole || experience === undefined || !certificationLevel) {
      res.status(400);
      throw new Error('Please fill in all profile fields');
    }

    const skillsArray = typeof skills === 'string' 
      ? skills.split(',').map(s => s.trim()).filter(Boolean)
      : (Array.isArray(skills) ? skills : []);

    // Create the assessment setup log first
    const assessment = await Assessment.create({
      userId: req.user._id,
      profile: {
        name,
        employeeId,
        department,
        jobRole,
        experience: Number(experience),
        skills: skillsArray,
        certificationLevel,
      },
      status: 'setup',
    });

    // Generate questions using AI
    console.log(`Generating adaptive questions for candidate: ${name}`);
    const questionsList = await generateQuestions({
      ...req.body,
      skills: skillsArray
    });

    // Save questions in the database
    const savedQuestions = [];
    for (const q of questionsList) {
      const savedQ = await Question.create({
        assessmentId: assessment._id,
        text: q.text,
        type: q.type,
        options: q.options || [],
        correctAnswer: q.correctAnswer,
        timerDuration: q.timerDuration || 60,
        order: q.order,
        topic: q.topic || 'General',
      });
      savedQuestions.push(savedQ._id);
    }

    // Associate questions and set status to active
    assessment.questions = savedQuestions;
    assessment.status = 'active';
    assessment.currentQuestionIndex = 0;
    await assessment.save();

    res.status(201).json({
      message: 'Assessment generated successfully',
      assessmentId: assessment._id,
      totalQuestions: savedQuestions.length,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get the current active question for an assessment
// @route   GET /api/assessments/:id/question
// @access  Private
export const getCurrentQuestion = async (req, res, next) => {
  try {
    const assessment = await Assessment.findById(req.params.id);

    if (!assessment) {
      res.status(404);
      throw new Error('Assessment not found');
    }

    if (assessment.userId.toString() !== req.user._id.toString()) {
      res.status(403);
      throw new Error('Unauthorized access to this assessment');
    }

    if (assessment.status === 'terminated') {
      return res.status(400).json({
        status: 'terminated',
        message: 'Assessment was terminated due to security violations',
      });
    }

    if (assessment.status === 'completed') {
      return res.status(200).json({
        status: 'completed',
        message: 'Assessment is already completed',
      });
    }

    const questionIndex = assessment.currentQuestionIndex;
    if (questionIndex >= assessment.questions.length) {
      assessment.status = 'completed';
      assessment.completedAt = new Date();
      await assessment.save();
      return res.status(200).json({
        status: 'completed',
        message: 'Assessment is complete. Proceed to evaluation.',
      });
    }

    // Fetch the question details
    const questionId = assessment.questions[questionIndex];
    const question = await Question.findById(questionId);

    if (!question) {
      res.status(500);
      throw new Error('Question not found in database');
    }

    // Return question without correctAnswer details to prevent client cheating
    res.json({
      assessmentId: assessment._id,
      status: assessment.status,
      questionIndex: questionIndex + 1,
      totalQuestions: assessment.questions.length,
      question: {
        _id: question._id,
        text: question.text,
        type: question.type,
        options: question.options,
        timerDuration: question.timerDuration,
        topic: question.topic,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Submit answer for the current question
// @route   POST /api/assessments/:id/answer
// @access  Private
export const submitAnswer = async (req, res, next) => {
  try {
    const { questionId, answerText, timeTaken, isUnanswered } = req.body;
    const assessment = await Assessment.findById(req.params.id);

    if (!assessment) {
      res.status(404);
      throw new Error('Assessment not found');
    }

    if (assessment.userId.toString() !== req.user._id.toString()) {
      res.status(403);
      throw new Error('Unauthorized');
    }

    if (assessment.status !== 'active') {
      res.status(400);
      throw new Error(`Assessment is not in active state (Current status: ${assessment.status})`);
    }

    // Check if user is submitting the correct question in sequence
    const currentQId = assessment.questions[assessment.currentQuestionIndex];
    if (currentQId.toString() !== questionId) {
      res.status(400);
      throw new Error('Mismatched question sequence submission');
    }

    // Save answer immediately
    const answer = await Answer.create({
      assessmentId: assessment._id,
      questionId,
      userId: req.user._id,
      answerText: isUnanswered ? '' : answerText,
      timeTaken: timeTaken || 0,
      isUnanswered: !!isUnanswered,
    });

    // Move to next question index
    assessment.currentQuestionIndex += 1;
    
    // Check if assessment completed
    if (assessment.currentQuestionIndex >= assessment.questions.length) {
      assessment.status = 'completed';
      assessment.completedAt = new Date();
    }

    await assessment.save();

    res.status(201).json({
      message: 'Answer submitted successfully',
      nextQuestionIndex: assessment.currentQuestionIndex,
      isCompleted: assessment.status === 'completed',
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Log a cheating incident
// @route   POST /api/assessments/:id/cheat
// @access  Private
export const logCheating = async (req, res, next) => {
  try {
    const { eventType } = req.body;
    const assessment = await Assessment.findById(req.params.id);

    if (!assessment) {
      res.status(404);
      throw new Error('Assessment not found');
    }

    if (assessment.userId.toString() !== req.user._id.toString()) {
      res.status(403);
      throw new Error('Unauthorized');
    }

    // Create log entry
    await CheatingLog.create({
      assessmentId: assessment._id,
      userId: req.user._id,
      eventType,
    });

    // Increment count
    assessment.cheatingCount += 1;

    // Check if threshold exceeded (3 and above terminates)
    if (assessment.cheatingCount >= 3) {
      assessment.status = 'terminated';
      await assessment.save();
      return res.status(200).json({
        message: 'Assessment terminated due to exceeding safety threshold',
        cheatingCount: assessment.cheatingCount,
        terminated: true,
      });
    }

    await assessment.save();

    res.json({
      message: 'Cheating incident logged successfully',
      cheatingCount: assessment.cheatingCount,
      terminated: false,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Evaluate assessment answers and compile report
// @route   POST /api/assessments/:id/evaluate
// @access  Private
export const evaluateAssessment = async (req, res, next) => {
  try {
    const assessment = await Assessment.findById(req.params.id);

    if (!assessment) {
      res.status(404);
      throw new Error('Assessment not found');
    }

    if (assessment.userId.toString() !== req.user._id.toString()) {
      res.status(403);
      throw new Error('Unauthorized');
    }

    if (assessment.status !== 'completed') {
      res.status(400);
      throw new Error('Assessment must be fully completed to evaluate');
    }

    // Check if report already exists for this assessment
    const existingReport = await Report.findOne({ assessmentId: assessment._id });
    if (existingReport) {
      const certificate = await Certificate.findOne({ assessmentId: assessment._id });
      return res.json({ report: existingReport, certificate });
    }

    // Get all answers
    const answers = await Answer.find({ assessmentId: assessment._id }).populate('questionId');

    console.log(`Starting AI grading for assessment: ${assessment._id}`);
    
    // Evaluate answers
    for (const ans of answers) {
      const q = ans.questionId;
      
      // Default score is 0 if unanswered
      if (ans.isUnanswered) {
        ans.evaluation = { score: 0, feedback: 'Question timed out. No response provided.' };
        await ans.save();
        continue;
      }

      const userAns = ans.answerText;
      const correctAns = q.correctAnswer;

      if (q.type === 'MCQ') {
        // MCQ Evaluation (Exact Match)
        const isCorrect = String(userAns).trim().toLowerCase() === String(correctAns).trim().toLowerCase();
        ans.evaluation = {
          score: isCorrect ? 100 : 0,
          feedback: isCorrect ? 'Correct option selected.' : `Incorrect. The correct option was: ${correctAns}`,
        };
      } 
      else if (q.type === 'MSQ') {
        // MSQ Evaluation (Partial Scoring)
        // correctAns is an array, userAns is an array
        const userAnswers = Array.isArray(userAns) ? userAns : [userAns];
        const correctAnswers = Array.isArray(correctAns) ? correctAns : [correctAns];

        const matched = userAnswers.filter(val => correctAnswers.includes(val)).length;
        const extraSelected = userAnswers.filter(val => !correctAnswers.includes(val)).length;
        
        // Calculate score percentage
        let scorePercent = 0;
        if (correctAnswers.length > 0) {
          scorePercent = Math.max(0, Math.round(((matched - extraSelected) / correctAnswers.length) * 100));
        }

        ans.evaluation = {
          score: scorePercent,
          feedback: `Selected ${matched} of ${correctAnswers.length} correct options. Extra incorrect options selected: ${extraSelected}`,
        };
      } 
      else {
        // AI evaluative models for Short, Long, Scenario, Logical, Analytical
        console.log(`Grading text response for Question [${q.type}] - Order: ${q.order}`);
        const result = await evaluateTextAnswer(q.text, q.type, userAns, correctAns);
        ans.evaluation = {
          score: result.score || 0,
          feedback: result.feedback || 'Evaluated successfully.',
        };
      }
      
      await ans.save();
    }

    // Compile analytics and report
    console.log(`Compiling final dashboard report...`);
    const report = await compileAssessmentReport(assessment, req.user._id);

    // Generate certificate if passed
    let certificate = null;
    if (report.passFail === 'Pass') {
      console.log(`Candidate passed! Creating certification log...`);
      const certificateId = `CERT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const verificationHash = crypto.createHash('sha256')
        .update(`${assessment._id}-${req.user._id}-${Date.now()}`)
        .digest('hex');

      certificate = await Certificate.create({
        userId: req.user._id,
        assessmentId: assessment._id,
        certificateId,
        name: assessment.profile.name,
        certificationName: `${assessment.profile.jobRole} Professional Certification`,
        level: assessment.profile.certificationLevel,
        score: report.overallScore,
        verificationHash,
      });
    }

    res.json({ report, certificate });
  } catch (error) {
    next(error);
  }
};

// @desc    Get historical assessment attempts for the user
// @route   GET /api/assessments/history
// @access  Private
export const getUserAssessments = async (req, res, next) => {
  try {
    const assessments = await Assessment.find({ userId: req.user._id }).sort({ createdAt: -1 });
    
    // Enrich with scores if reports exist
    const enrichedHistory = [];
    for (const ass of assessments) {
      const report = await Report.findOne({ assessmentId: ass._id }).select('overallScore passFail');
      const certificate = await Certificate.findOne({ assessmentId: ass._id }).select('certificateId');
      
      enrichedHistory.push({
        _id: ass._id,
        profile: ass.profile,
        status: ass.status,
        cheatingCount: ass.cheatingCount,
        createdAt: ass.createdAt,
        completedAt: ass.completedAt,
        score: report ? report.overallScore : null,
        passFail: report ? report.passFail : null,
        certificateId: certificate ? certificate.certificateId : null,
      });
    }

    res.json(enrichedHistory);
  } catch (error) {
    next(error);
  }
};

// @desc    Terminate assessment prematurely
// @route   POST /api/assessments/:id/terminate
// @access  Private
export const terminateAssessment = async (req, res, next) => {
  try {
    const assessment = await Assessment.findById(req.params.id);
    if (!assessment) {
      res.status(404);
      throw new Error('Assessment not found');
    }
    if (assessment.userId.toString() !== req.user._id.toString()) {
      res.status(403);
      throw new Error('Unauthorized');
    }

    assessment.status = 'terminated';
    await assessment.save();

    res.json({
      message: 'Assessment was terminated successfully',
      status: 'terminated'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Analyze candidate onboarding chat to suggest Role and Certification Level
// @route   POST /api/assessments/analyze-persona
// @access  Private
export const analyzePersona = async (req, res, next) => {
  try {
    const { jobRoleFocus, experience, skills, projects, aiExperience } = req.body;

    if (experience === undefined || isNaN(experience) || Number(experience) < 0) {
      res.status(400);
      throw new Error('Please provide valid years of experience');
    }

    console.log('Analyzing candidate onboarding responses to suggest role and level...');
    const result = await determinePersonaRoleAndLevel({
      jobRoleFocus,
      experience,
      skills,
      projects,
      aiExperience,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
};
