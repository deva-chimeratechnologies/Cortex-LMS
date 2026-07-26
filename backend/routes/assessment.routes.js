import express from 'express';
import { 
  startAssessment, 
  getCurrentQuestion, 
  submitAnswer, 
  logCheating, 
  evaluateAssessment, 
  getUserAssessments,
  terminateAssessment,
  analyzePersona
} from '../controllers/assessment.controller.js';
import { protect } from '../middleware/auth.middleware.js';
import { 
  validateStartAssessment, 
  validateSubmitAnswer, 
  validateCheatLog 
} from '../validators/assessment.validator.js';

const router = express.Router();

router.use(protect); // Protect all routes below

router.post('/start', validateStartAssessment, startAssessment);
router.post('/analyze-persona', analyzePersona);
router.get('/history', getUserAssessments);
router.get('/:id/question', getCurrentQuestion);
router.post('/:id/answer', validateSubmitAnswer, submitAnswer);
router.post('/:id/cheat', validateCheatLog, logCheating);
router.post('/:id/evaluate', evaluateAssessment);
router.post('/:id/terminate', terminateAssessment);

export default router;
