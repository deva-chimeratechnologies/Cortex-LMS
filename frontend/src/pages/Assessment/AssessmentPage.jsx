import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useCheatingDetection } from '../../hooks/useCheatingDetection';
import api from '../../services/api';
import ChatBubble from '../../components/Chat/ChatBubble';
import Loader from '../../components/Common/Loader';
import { Send, Clock, AlertTriangle, ShieldCheck, Play, ArrowRight, CornerDownLeft } from 'lucide-react';


const AssessmentPage = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const resumeId = searchParams.get('resume');

  // Chat message logs
  const [messages, setMessages] = useState([]);
  const [isAgentTyping, setIsAgentTyping] = useState(false);
  const [inputVal, setInputVal] = useState('');

  // Profile collection state variables
  const [profileStep, setProfileStep] = useState('jobRole');
  const [profile, setProfile] = useState({
    name: user?.name || '',
    employeeId: user?.employeeId || '',
    department: user?.department || 'Engineering',
    jobRoleFocus: '',
    experience: '',
    skills: Array.isArray(user?.skills) ? user.skills.join(', ') : (user?.skills || ''),
    projects: '',
    aiExperience: '',
    jobRole: '',
    certificationLevel: '',
  });
  const [isStartingExam, setIsStartingExam] = useState(false);



  // Active exam states
  const [assessmentId, setAssessmentId] = useState(null);
  const [isTesting, setIsTesting] = useState(false);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const [questionNum, setQuestionNum] = useState(0);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState(null); // String or Array for MSQ

  // Timers and violations
  const [timer, setTimer] = useState(60);
  const [cheatingCount, setCheatingCount] = useState(0);
  const [showWarningModal, setShowWarningModal] = useState(false);
  const [warningMessage, setWarningMessage] = useState('');
  const [isTerminated, setIsTerminated] = useState(false);
  const [gradingProgress, setGradingProgress] = useState(false);
  const [isFullscreenActive, setIsFullscreenActive] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showSubmitConfirmModal, setShowSubmitConfirmModal] = useState(false);
  const [terminationReason, setTerminationReason] = useState('security'); // 'security' or 'user-abort'

  const chatEndRef = useRef(null);
  const timerIntervalRef = useRef(null);

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isAgentTyping]);

  // Keep local fullscreen state in sync so we can show a re-enter action.
  useEffect(() => {
    const syncFullscreenState = () => {
      setIsFullscreenActive(Boolean(document.fullscreenElement));
    };

    syncFullscreenState();
    document.addEventListener('fullscreenchange', syncFullscreenState);

    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState);
    };
  }, []);

  // Initial Greet or Resume Fetch
  useEffect(() => {
    const init = async () => {
      if (resumeId) {
        // Resuming an existing assessment
        setLoadingResume(true);
        try {
          const { data } = await api.get(`/api/assessments/${resumeId}/question`);
          if (data.status === 'terminated') {
            setIsTerminated(true);
          } else if (data.status === 'completed') {
            navigate(`/results/${resumeId}`);
          } else {
            setAssessmentId(resumeId);
            setQuestionNum(data.questionIndex);
            setTotalQuestions(data.totalQuestions);
            setCurrentQuestion(data.question);
            setTimer(data.question.timerDuration);
            setIsTesting(true);
            setProfileStep('testing');

            // Build greeting
            setMessages([
              { sender: 'ai', text: `Resuming assessment in progress. We are at question ${data.questionIndex} of ${data.totalQuestions}.` }
            ]);
          }
        } catch (err) {
          console.error(err);
          // Fallback to fresh setup
          startFreshSetup();
        } finally {
          setLoadingResume(false);
        }
      } else {
        startFreshSetup();
      }
    };
    init();
  }, [resumeId]);

  const [loadingResume, setLoadingResume] = useState(false);

  const startFreshSetup = () => {
    setIsAgentTyping(true);
    setTimeout(() => {
      setMessages([
        {
          sender: 'ai',
          text: `Hello! I am your AI Assessment Agent. I will configure your persona to generate a custom certification assessment for you.\n\nFirst, describe your daily focus or role. (e.g., Do you write code, design system architectures, or lead developer teams?):`,
        },
      ]);
      setIsAgentTyping(false);
    }, 800);
  };

  // Assessment individual question timer ticking
  useEffect(() => {
    if (!isTesting || !currentQuestion || isTerminated || gradingProgress) return;

    // Reset interval on question update
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);

    timerIntervalRef.current = setInterval(() => {
      setTimer((prev) => {
        if (prev <= 1) {
          clearInterval(timerIntervalRef.current);
          handleTimeOutSubmit();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, [isTesting, currentQuestion, isTerminated, gradingProgress]);

  // Cheating hook hookup
  const handleWarningDetected = (eventType, count) => {
    setCheatingCount(count);
    setWarningMessage(`Warning: ${eventType} detected! Multiple security violations will automatically fail and discard your assessment.`);
    setShowWarningModal(true);
  };

  const handleTerminationTriggered = () => {
    setIsTerminated(true);
    setTerminationReason('security');
    setIsTesting(false);
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(err => console.log(err));
    }
  };

  useCheatingDetection(assessmentId, isTesting, handleWarningDetected, handleTerminationTriggered);

  // Submit on timeout
  const handleTimeOutSubmit = async () => {
    if (!assessmentId || !currentQuestion) return;

    // Auto submit unanswered
    try {
      await api.post(`/api/assessments/${assessmentId}/answer`, {
        questionId: currentQuestion._id,
        answerText: '',
        timeTaken: currentQuestion.timerDuration,
        isUnanswered: true,
      });

      setMessages((prev) => [
        ...prev,
        {
          sender: 'user',
          text: `Question ${questionNum}: ${currentQuestion.text}\n\nAnswer: Unanswered (time expired)`
        }
      ]);
      appendAiMessage(`Timer expired! Moving to the next question.`);
      loadNextQuestion();
    } catch (err) {
      console.error(err);
    }
  };

  const requestExamFullscreen = async () => {
    if (!document.documentElement.requestFullscreen) return;
    if (document.fullscreenElement) return;

    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch (err) {
      console.warn('Fullscreen request blocked by browser. Continuing...', err);
    }
  };

  // Append AI text agent bubble helper
  const appendAiMessage = (text) => {
    setMessages((prev) => [...prev, { sender: 'ai', text }]);
  };

  const PERSONA_BRIEFS = {
    Beginner: [
      "Core Technical Basics: Understanding of fundamental programming paradigms, variables, loops, control structures, and simple data schemas.",
      "Standard Tool Familiarity: Competency in using basic developer tools such as git version control, IDEs, and executing scripts.",
      "Application Development: Capability to build simple local applications, small helper scripts, or basic UI frontend components under supervision.",
      "Problem Solving: Aptitude for troubleshooting basic syntax errors, reading debugging logs, and implementing standard algorithm rules.",
      "Team Collaboration: Awareness of basic agile practices, tasks boards, and standard peer code review conventions."
    ],
    Intermediate: [
      "System Design & API Integration: Competence in designing RESTful web APIs, relational/non-relational database schemas, and modular components.",
      "Independent Feature Implementation: Ability to take ownership of end-to-end feature modules, resolve edge cases, and integrate third-party services.",
      "Testing & Quality Assurance: Proficiency in writing robust unit, integration, and regression tests to guarantee code coverage and product reliability.",
      "Performance Tuning & Optimization: Skill in profiling database query bottlenecks, implementing basic caching layers, and optimizing resource assets.",
      "CI/CD & Production Deployment: Experience building containerized environments (Docker), configuring automation workflows, and monitoring application logs."
    ],
    Advanced: [
      "Enterprise Architecture Design: Expertise in microservices patterns, distributed caching, event-driven integrations, and high-availability systems.",
      "Technical Leadership & Mentorship: Experience leading developer teams, setting coding standards, conducting system design reviews, and guiding peers.",
      "Infrastructure & Cloud Native Scale: Designing Kubernetes cluster topologies, managing infrastructure-as-code scripts, and scaling distributed networks.",
      "Security, Compliance & Vulnerabilities: Implementing advanced cryptography, secure access controls (OAuth, SAML), and regulatory compliance audits.",
      "Operational Reliability & Recovery: Optimizing extreme data workloads, configuring automated failovers, circuit breakers, and disaster recovery strategies."
    ]
  };

  // Profile input step handler
  const handleProfileInputSubmit = async (value) => {
    if (!value.trim()) return;

    // Append candidate message
    setMessages((prev) => [...prev, { sender: 'user', text: value }]);
    setInputVal('');

    // Advance states
    switch (profileStep) {
      case 'jobRole':
        setProfile((prev) => ({ ...prev, jobRoleFocus: value }));
        setProfileStep('experience');
        setIsAgentTyping(true);
        setTimeout(() => {
          appendAiMessage('How many years of professional experience do you have?');
          setIsAgentTyping(false);
          setInputVal('');
        }, 600);
        break;

      case 'experience':
        if (isNaN(value) || Number(value) < 0) {
          appendAiMessage('Please enter a valid numeric value for your years of experience.');
          return;
        }
        setProfile((prev) => ({ ...prev, experience: Number(value) }));
        setProfileStep('skills');
        setIsAgentTyping(true);
        setTimeout(() => {
          appendAiMessage('What core technical skills and tools do you use regularly? (comma separated, e.g. Java, Python, Docker, Kubernetes, Git):');
          setIsAgentTyping(false);
          setInputVal('');
        }, 600);
        break;

      case 'skills':
        setProfile((prev) => ({ ...prev, skills: value }));
        setProfileStep('projects');
        setIsAgentTyping(true);
        setTimeout(() => {
          appendAiMessage('What key projects have you built? Describe their scope and your contributions briefly:');
          setIsAgentTyping(false);
          setInputVal('');
        }, 600);
        break;

      case 'projects':
        setProfile((prev) => ({ ...prev, projects: value }));
        setProfileStep('aiExperience');
        setIsAgentTyping(true);
        setTimeout(() => {
          appendAiMessage('What has been your experience with AI integration and Cortex features like RAG, Agents, or APIs? (e.g., Have you built any or are you new to them?):');
          setIsAgentTyping(false);
          setInputVal('');
        }, 600);
        break;

      case 'aiExperience':
        setIsAgentTyping(true);
        try {
          const rawProfileData = {
            jobRoleFocus: profile.jobRoleFocus,
            experience: Number(profile.experience),
            skills: profile.skills,
            projects: profile.projects,
            aiExperience: value
          };

          // Call backend endpoint to analyze persona
          const { data } = await api.post('/api/assessments/analyze-persona', rawProfileData);
          const { jobRole, certificationLevel } = data;

          const finalProfile = {
            name: profile.name,
            employeeId: user?.employeeId || 'EMP-TEMP',
            department: user?.department || 'Engineering',
            jobRoleFocus: profile.jobRoleFocus,
            experience: Number(profile.experience),
            skills: profile.skills,
            projects: profile.projects,
            aiExperience: value,
            jobRole,
            certificationLevel
          };

          setProfile(finalProfile);
          setProfileStep('ready');

          const briefPoints = PERSONA_BRIEFS[certificationLevel].map((pt, idx) => `${idx + 1}. ${pt}`).join('\n');

          appendAiMessage(`Based on our conversation, I have analyzed your background:

**Suggested Target Assessment:**
* **Role Persona:** ${jobRole}
* **Certification Level:** ${certificationLevel}

---

### Suggested Persona Brief
To succeed at the **${certificationLevel} ${jobRole}** tier, you should have the following roles, responsibilities, and skillsets:

${briefPoints}

---

Ready to proceed to the exam rules review?`);
        } catch (err) {
          console.error('Failed to analyze persona:', err);
          const expYears = Number(profile.experience) || 0;
          const fallbackLvl = expYears >= 5 ? 'Advanced' : (expYears >= 2 ? 'Intermediate' : 'Beginner');
          const finalProfile = {
            name: profile.name,
            employeeId: user?.employeeId || 'EMP-TEMP',
            department: user?.department || 'Engineering',
            jobRoleFocus: profile.jobRoleFocus,
            experience: Number(profile.experience),
            skills: profile.skills,
            projects: profile.projects,
            aiExperience: value,
            jobRole: 'Developer',
            certificationLevel: fallbackLvl
          };
          setProfile(finalProfile);
          setProfileStep('ready');
          appendAiMessage(`Setup complete! I suggest taking the **${fallbackLvl} Developer** certification path. Ready to proceed to the exam rules review?`);
        } finally {
          setIsAgentTyping(false);
          setInputVal('');
        }
        break;

      default:
        break;
    }
  };

  // Launch assessment API
  const handleStartExam = async () => {
    if (isStartingExam) return;
    setIsStartingExam(true);
    setIsAgentTyping(true);
    try {
      // Request fullscreen while the click gesture is still active.
      await requestExamFullscreen();

      const { data } = await api.post('/api/assessments/start', profile);
      setAssessmentId(data.assessmentId);
      setTotalQuestions(data.totalQuestions);

      setShowRules(false); // Close modal when questions are successfully loaded and DB created
      setProfileStep('testing');
      setIsTesting(true);

      // Fetch first question
      const qRes = await api.get(`/api/assessments/${data.assessmentId}/question`);
      setQuestionNum(qRes.data.questionIndex);
      setCurrentQuestion(qRes.data.question);
      setTimer(qRes.data.question.timerDuration);

      setMessages((prev) => [
        ...prev,
        { sender: 'ai', text: `Welcome to the active exam interface. We have generated exactly 20 questions based on your profile.\n\nRules:\n1. Solve one question at a time.\n2. Timers tick individually.\n3. Exiting fullscreen/switching tabs is tracked.\n\nLet's begin with Question 1!` }
      ]);
    } catch (err) {
      console.error(err);
      appendAiMessage('An error occurred during assessment generation. Please try starting again.');
    } finally {
      setIsAgentTyping(false);
      setIsStartingExam(false);
    }
  };

  // Load next question
  const loadNextQuestion = async () => {
    setSelectedAnswer(null);
    try {
      const { data } = await api.get(`/api/assessments/${assessmentId}/question`);

      if (data.status === 'completed') {
        // Assessment finished, transition to grading loader
        setIsTesting(false);
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(err => console.log(err));
        }
        runPostGradingAI();
      } else {
        setQuestionNum(data.questionIndex);
        setCurrentQuestion(data.question);
        setTimer(data.question.timerDuration);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Run final AI evaluation
  const runPostGradingAI = async () => {
    setGradingProgress(true);
    try {
      await api.post(`/api/assessments/${assessmentId}/evaluate`);
      navigate(`/results/${assessmentId}`);
    } catch (err) {
      console.error(err);
      setGradingProgress(false);
      appendAiMessage('Evaluation error occurred. Please contact admin.');
    }
  };

  // Submit Answer Action
  const handleSubmitActiveAnswer = async () => {
    if (!selectedAnswer && selectedAnswer !== '' && currentQuestion.type !== 'Short' && currentQuestion.type !== 'Long' && currentQuestion.type !== 'Scenario' && currentQuestion.type !== 'Logical' && currentQuestion.type !== 'Analytical') {
      alert('Please provide or select an answer before proceeding.');
      return;
    }

    const timeTaken = currentQuestion.timerDuration - timer;

    try {
      // Append candidate response bubble
      const answerDisplay = Array.isArray(selectedAnswer)
        ? selectedAnswer.join(', ')
        : (selectedAnswer || 'Answer submitted');

      setMessages((prev) => [
        ...prev,
        {
          sender: 'user',
          text: `Question ${questionNum}: ${currentQuestion.text}\n\nAnswer: ${answerDisplay}`
        }
      ]);

      await api.post(`/api/assessments/${assessmentId}/answer`, {
        questionId: currentQuestion._id,
        answerText: selectedAnswer || '',
        timeTaken,
      });

      loadNextQuestion();
    } catch (err) {
      console.error(err);
    }
  }
  // Handle click on the Submit button
  const handleSubmitExamClick = () => {
    if (questionNum === totalQuestions) {
      if (!selectedAnswer && selectedAnswer !== '' && currentQuestion.type !== 'Short' && currentQuestion.type !== 'Long' && currentQuestion.type !== 'Scenario' && currentQuestion.type !== 'Logical' && currentQuestion.type !== 'Analytical') {
        alert('Please provide or select an answer before submitting.');
        return;
      }
    }
    setShowSubmitConfirmModal(true);
  };

  // Prematurely terminate assessment
  const handleTerminateExamPrematurely = async () => {
    try {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      await api.post(`/api/assessments/${assessmentId}/terminate`);
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => console.log(err));
      }
      setIsTerminated(true);
      setTerminationReason('user-abort');
      setIsTesting(false);
      setShowSubmitConfirmModal(false);
    } catch (err) {
      console.error(err);
    }
  };

  // Final successful submit of assessment
  const handleFinalSuccessfulSubmit = async () => {
    try {
      const timeTaken = currentQuestion.timerDuration - timer;
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);

      await api.post(`/api/assessments/${assessmentId}/answer`, {
        questionId: currentQuestion._id,
        answerText: selectedAnswer || '',
        timeTaken,
      });

      setShowSubmitConfirmModal(false);
      setIsTesting(false);
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => console.log(err));
      }
      runPostGradingAI();
    } catch (err) {
      console.error(err);
    }
  };

  // Restart terminated exam
  const handleRestartExam = () => {
    setIsTerminated(false);
    setAssessmentId(null);
    setIsTesting(false);
    setProfileStep('useCases');
    setShowRules(false);
    startFreshSetup();
  };

  if (loadingResume) return <Loader message="Retrieving ongoing assessment..." fullScreen />;
  if (gradingProgress) return <Loader message="Analyzing results. Calculating subject topic competence and writing final feedback summary report..." fullScreen />;

  if (showRules) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 min-h-[82vh] flex items-center justify-center text-slate-950">
        <div className="bg-white border border-slate-200 p-8 rounded-2xl flex flex-col space-y-6 overflow-y-auto max-h-[80vh] shadow-lg w-full">
          {/* Header */}
          <div className="text-center">
            <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight flex items-center justify-center space-x-2">
              <ShieldCheck className="w-7 h-7 text-[#ff6a1f]" />
              <span>Assessment Rules & Instructions</span>
            </h2>
            <p className="text-xs text-slate-500 mt-1">Please read all instructions carefully before starting the exam.</p>
          </div>

          {/* Rules body */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
            <div className="space-y-4">
              {/* Security */}
              <div className="border border-slate-100 p-4 rounded-xl bg-slate-50 space-y-2">
                <h3 className="font-bold text-[#ff6a1f] flex items-center space-x-1.5 text-xs uppercase tracking-wider">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-[#ff6a1f]" />
                  <span>Security & Integrity</span>
                </h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Tab switching, copying, pasting, right-clicking, and exiting fullscreen are strictly prohibited. Doing any of these logs a security violation.
                </p>
                <div className="text-[10px] text-red-600 font-bold bg-red-50 border border-red-100 rounded px-2.5 py-1 inline-block">
                  MAXIMUM 3 WARNINGS ALLOWED
                </div>
              </div>

              {/* Attempts */}
              <div className="border border-slate-100 p-4 rounded-xl bg-slate-50 space-y-2">
                <h3 className="font-bold text-[#ff6a1f] flex items-center space-x-1.5 text-xs uppercase tracking-wider">
                  <Play className="w-4 h-4 shrink-0 text-[#ff6a1f]" />
                  <span>Attempt Details</span>
                </h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Only 1 attempt is allowed. Once you begin, you cannot pause or resume later. You must stay online until completion.
                </p>
              </div>

              {/* Fullscreen */}
              <div className="border border-slate-100 p-4 rounded-xl bg-slate-50 space-y-2">
                <h3 className="font-bold text-[#ff6a1f] flex items-center space-x-1.5 text-xs uppercase tracking-wider">
                  <ShieldCheck className="w-4 h-4 shrink-0 text-[#ff6a1f]" />
                  <span>Fullscreen Requirement</span>
                </h3>
                <p className="text-xs text-slate-600 leading-relaxed">
                  The test runs strictly in fullscreen mode. Leaving fullscreen triggers an immediate integrity warning.
                </p>
              </div>
            </div>

            {/* Timings */}
            <div className="border border-slate-100 p-4 rounded-xl bg-slate-50 space-y-3">
              <h3 className="font-bold text-[#ff6a1f] flex items-center space-x-1.5 text-xs uppercase tracking-wider">
                <Clock className="w-4 h-4 shrink-0 text-[#ff6a1f]" />
                <span>Timing Allotments</span>
              </h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                Timers tick individually for each question. Unanswered questions submit automatically when time expires.
              </p>

              {/* Timing Table */}
              <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                <table className="min-w-full text-xs text-left">
                  <thead className="bg-slate-50 font-bold border-b border-slate-200 text-slate-700">
                    <tr>
                      <th className="px-3 py-2">Question Type</th>
                      <th className="px-3 py-2 text-right">Time Allotment</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-600">
                    <tr>
                      <td className="px-3 py-2 font-medium text-slate-800">Multiple Choice (MCQ)</td>
                      <td className="px-3 py-2 text-right">30s</td>
                    </tr>
                    <tr>
                      <td className="px-3 py-2 font-medium text-slate-800">Multiple Selection (MSQ)</td>
                      <td className="px-3 py-2 text-right">45s</td>
                    </tr>
                    <tr>
                      <td className="px-3 py-2 font-medium text-slate-800">Short Answer</td>
                      <td className="px-3 py-2 text-right">90s (1.5m)</td>
                    </tr>
                    <tr>
                      <td className="px-3 py-2 font-medium text-slate-800">Logical / Analytical</td>
                      <td className="px-3 py-2 text-right">120s (2m)</td>
                    </tr>
                    <tr>
                       <td className="px-3 py-2 font-medium text-slate-800">Scenario-based</td>
                       <td className="px-3 py-2 text-right">240s (4m)</td>
                     </tr>
                     <tr>
                       <td className="px-3 py-2 font-medium text-slate-800">Coding / Labs</td>
                       <td className="px-3 py-2 text-right">300s (5m)</td>
                     </tr>
                     <tr>
                       <td className="px-3 py-2 font-medium text-slate-800">Long Answer</td>
                       <td className="px-3 py-2 text-right">300s (5m)</td>
                     </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex flex-col sm:flex-row justify-end gap-3 pt-4 border-t border-slate-100">
            <button
              onClick={() => setShowRules(false)}
              className="px-5 py-2.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold text-sm transition-colors"
            >
              Back to Chat
            </button>
            <button
              onClick={() => {
                handleStartExam();
              }}
              disabled={isStartingExam}
              className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-[#ff6a1f] to-[#ff4a03] hover:from-[#ff4a03] hover:to-[#d63d04] text-white font-bold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_10px_24px_rgba(255,106,31,0.22)]"
            >
              {isStartingExam ? 'Generating Assessment...' : 'Acknowledge & Start Exam'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isExamMode = isTesting || isTerminated;
  const showActiveExamLayout = isTesting && currentQuestion;

  return (
    <div
      className={isExamMode
        ? 'fixed inset-0 z-[70] flex h-screen w-screen flex-col overflow-hidden bg-gradient-to-br from-[#fffdf9] via-white to-[#fff4eb] px-4 py-4 text-slate-950 sm:px-6 lg:px-8'
        : 'max-w-4xl mx-auto px-4 py-8 h-[82vh] flex flex-col justify-between text-slate-950'}
    >

      {/* 1. DISQUALIFIED SCREEN */}
      {isTerminated ? (
        <div className="bg-white border border-red-200 p-8 rounded-2xl flex flex-col items-center justify-center space-y-6 my-auto text-center shadow-sm">
          <AlertTriangle className="w-16 h-16 text-red-500 animate-bounce" />
          <h2 className="text-2xl font-extrabold text-slate-950">
            {terminationReason === 'user-abort' ? 'Assessment Terminated' : 'Assessment Disqualified'}
          </h2>
          <p className="text-sm text-slate-600 max-w-md">
            {terminationReason === 'user-abort'
              ? 'You chose to submit the assessment before finishing all questions. This attempt has been terminated and permanently discarded.'
              : 'The security integrity system logged 3 or more tab switching/exit-fullscreen events. This attempt has been permanently discarded.'}
          </p>
          <button
            onClick={handleRestartExam}
            className="px-6 py-3 bg-gradient-to-r from-[#ff6a1f] to-[#ff4a03] hover:from-[#ff4a03] hover:to-[#d63d04] text-white font-semibold rounded-xl text-sm transition-all shadow-[0_10px_24px_rgba(255,106,31,0.22)]"
          >
            Restart New Assessment
          </button>
        </div>
      ) : (
        <>
          {/* Active test stats banner */}
          {showActiveExamLayout ? (
            <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
              <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex flex-wrap justify-between items-center space-y-2 sm:space-y-0 shadow-sm shrink-0">
                <div className="flex items-center space-x-3 text-xs font-semibold">
                  <span className="text-[#ff6a1f]">Exam: Active</span>
                  <span className="text-slate-300">|</span>
                  <span className="text-slate-700">Question {questionNum} / {totalQuestions}</span>
                  <span className="text-slate-300">|</span>
                  <span className="text-slate-500 uppercase tracking-wider">{currentQuestion.type}</span>
                </div>

                <div className="flex items-center flex-wrap justify-end gap-3">
                  {!isFullscreenActive && (
                    <button
                      onClick={requestExamFullscreen}
                      className="px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white bg-gradient-to-r from-[#ff6a1f] to-[#ff4a03] hover:from-[#ff4a03] hover:to-[#d63d04] shadow-[0_8px_18px_rgba(255,106,31,0.20)]"
                    >
                      Re-enter Fullscreen
                    </button>
                  )}
                  <div className={`flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-bold border
                    ${timer <= 15
                      ? 'bg-[#fff4eb] border-[#ff6a1f] text-[#d63d04] animate-pulse'
                      : 'bg-[#fff4eb] border-[#ff8b4d] text-[#ff4a03]'}`}
                  >
                    <Clock className="w-4 h-4 shrink-0" />
                    <span>{timer}s left</span>
                  </div>
                  <div className="text-[10px] text-[#ff4a03] font-semibold uppercase">
                    Violations: {cheatingCount} / 3
                  </div>
                </div>
              </div>

              <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[1.15fr_0.95fr]">
                <div className="flex min-h-0 flex-col rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                    <div>
                      <span className="text-[10px] text-[#ff6a1f] font-bold uppercase tracking-wider">Live Chat</span>
                      <p className="text-sm text-slate-600">Assessment agent conversation and prompts</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {!isFullscreenActive && (
                        <button
                          onClick={requestExamFullscreen}
                          className="px-3 py-1 rounded-lg text-[10px] font-semibold uppercase tracking-wider text-white bg-gradient-to-r from-[#ff6a1f] to-[#ff4a03] hover:from-[#ff4a03] hover:to-[#d63d04] shadow-[0_8px_16px_rgba(255,106,31,0.20)]"
                        >
                          Re-enter Fullscreen
                        </button>
                      )}
                      <div className="rounded-full border border-[#ffd0aa] bg-[#fff4eb] px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#d63d04]">
                        Full Screen Mode
                      </div>
                    </div>
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-2 mt-4 bg-transparent rounded-2xl">
                    {messages.map((m, idx) => (
                      <ChatBubble key={idx} sender={m.sender} text={m.text} />
                    ))}
                    {isAgentTyping && <ChatBubble sender="ai" isTyping />}
                    <div ref={chatEndRef}></div>
                  </div>

                  {profileStep !== 'ready' && !isTesting && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleProfileInputSubmit(inputVal);
                      }}
                      className="mt-4 flex space-x-3 rounded-2xl border border-slate-200 bg-slate-50 p-2 items-center shadow-sm"
                    >
                      <input
                        type="text"
                        value={inputVal}
                        onChange={(e) => setInputVal(e.target.value)}
                        placeholder="Type your response here..."
                        className="flex-1 bg-transparent py-2 px-3 text-sm focus:outline-none text-slate-950 placeholder-slate-400 cursor-text"
                        style={{ caretColor: '#ff6a1f' }}
                      />
                      <button
                        type="submit"
                        className="p-2.5 bg-gradient-to-r from-[#ff6a1f] to-[#ff4a03] hover:from-[#ff4a03] hover:to-[#d63d04] text-white rounded-xl transition-colors active:scale-95 shrink-0 shadow-[0_8px_18px_rgba(255,106,31,0.20)]"
                      >
                        <Send className="w-4 h-4" />
                      </button>
                    </form>
                  )}

                  {profileStep === 'ready' && !isTesting && (
                    <div className="mt-4 flex justify-center">
                      <button
                        onClick={() => setShowRules(true)}
                        className="flex items-center space-x-2 px-6 py-3 bg-gradient-to-r from-[#ff6a1f] to-[#ff4a03] hover:from-[#ff4a03] hover:to-[#d63d04] text-white font-semibold rounded-xl transition-all shadow-[0_12px_28px_rgba(255,106,31,0.24)]"
                      >
                        <Play className="w-4 h-4" />
                        <span>Start Fullscreen Assessment</span>
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex min-h-0 flex-col rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="space-y-1 border-b border-slate-200 pb-3">
                    <span className="text-[10px] text-[#ff6a1f] font-bold uppercase tracking-wider">Active Question</span>
                    <p className="text-sm font-bold text-slate-950 leading-relaxed">{currentQuestion.text}</p>
                  </div>

                  <div className="mt-4 flex-1 min-h-0 overflow-y-auto space-y-5 pr-1">
                    {currentQuestion.type === 'MCQ' && (
                      <div className="grid grid-cols-1 gap-3">
                        {currentQuestion.options.map((opt, idx) => (
                          <label
                            key={idx}
                            className={`flex items-center space-x-3 p-3 rounded-xl border text-sm cursor-pointer transition-all
                              ${selectedAnswer === opt
                                ? 'bg-[#fff4eb] border-[#ff6a1f] text-slate-950 shadow-sm'
                                : 'bg-white border-slate-200 hover:border-[#ff8b4d] text-slate-700'}`}
                          >
                            <input
                              type="radio"
                              name="mcq"
                              value={opt}
                              checked={selectedAnswer === opt}
                              onChange={() => setSelectedAnswer(opt)}
                              className="sr-only"
                            />
                            <span className="font-mono text-xs w-5 h-5 flex items-center justify-center bg-slate-100 border border-slate-200 rounded-full text-slate-700">{String.fromCharCode(65 + idx)}</span>
                            <span>{opt}</span>
                          </label>
                        ))}
                      </div>
                    )}

                    {currentQuestion.type === 'MSQ' && (
                      <div className="grid grid-cols-1 gap-3">
                        {currentQuestion.options.map((opt, idx) => {
                          const ansArray = Array.isArray(selectedAnswer) ? selectedAnswer : [];
                          const isSelected = ansArray.includes(opt);

                          const handleCheckboxToggle = () => {
                            if (isSelected) {
                              setSelectedAnswer(ansArray.filter(v => v !== opt));
                            } else {
                              setSelectedAnswer([...ansArray, opt]);
                            }
                          };

                          return (
                            <label
                              key={idx}
                              className={`flex items-center space-x-3 p-3 rounded-xl border text-sm cursor-pointer transition-all
                                ${isSelected
                                  ? 'bg-[#fff4eb] border-[#ff6a1f] text-slate-950 shadow-sm'
                                  : 'bg-white border-slate-200 hover:border-[#ff8b4d] text-slate-700'}`}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={handleCheckboxToggle}
                                className="sr-only"
                              />
                              <span className="font-mono text-xs w-5 h-5 flex items-center justify-center bg-slate-100 border border-slate-200 rounded-full text-slate-700">{String.fromCharCode(65 + idx)}</span>
                              <span>{opt}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}

                    {currentQuestion.type === 'Short' && (
                      <div className="relative">
                        <input
                          type="text"
                          value={selectedAnswer || ''}
                          onChange={(e) => setSelectedAnswer(e.target.value)}
                          placeholder="Type your short answer response..."
                          className="w-full bg-white border border-slate-200 rounded-xl py-3 px-4 text-sm focus:outline-none focus:border-[#ff6a1f] text-slate-950 placeholder-slate-400"
                          style={{ caretColor: '#ff6a1f' }}
                        />
                      </div>
                    )}

                    {['Long', 'Scenario', 'Logical', 'Analytical'].includes(currentQuestion.type) && (() => {
                      const isCodeFocused = currentQuestion.type === 'Scenario' && (
                        currentQuestion.topic?.toLowerCase().includes('coding') ||
                        currentQuestion.topic?.toLowerCase().includes('code') ||
                        currentQuestion.text?.toLowerCase().includes('write code') ||
                        currentQuestion.text?.toLowerCase().includes('api') ||
                        currentQuestion.text?.toLowerCase().includes('sdk')
                      );
                      return (
                        <div className="relative">
                          <textarea
                            rows={7}
                            value={selectedAnswer || ''}
                            onChange={(e) => setSelectedAnswer(e.target.value)}
                            placeholder={isCodeFocused ? "// Write your code or configuration here...\n" : "Write your comprehensive analysis response here... (Pseudocode or detailed steps welcome)"}
                            className={`w-full border rounded-xl py-3 px-4 text-sm focus:outline-none focus:border-[#ff6a1f] resize-none
                              ${isCodeFocused 
                                ? 'bg-slate-950 border-slate-800 text-emerald-400 font-mono' 
                                : 'bg-white border-slate-200 text-slate-950 placeholder-slate-400'}`}
                            style={{ caretColor: '#ff6a1f' }}
                          />
                        </div>
                      );
                    })()}
                  </div>

                  {isTesting && currentQuestion && (
                    <div className="mt-4 flex justify-between items-center border-t border-slate-200 pt-4">
                      {questionNum < totalQuestions ? (
                        <>
                          <button
                            type="button"
                            onClick={handleSubmitExamClick}
                            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl text-xs transition-colors"
                          >
                            Submit Exam
                          </button>
                          <button
                            type="button"
                            onClick={handleSubmitActiveAnswer}
                            className="flex items-center space-x-1.5 px-5 py-2.5 bg-gradient-to-r from-[#ff6a1f] to-[#ff4a03] hover:from-[#ff4a03] hover:to-[#d63d04] text-white font-semibold rounded-xl text-xs transition-all shadow-[0_10px_24px_rgba(255,106,31,0.22)] active:scale-95"
                          >
                            <span>Next Question</span>
                            <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={handleSubmitExamClick}
                          className="w-full flex items-center justify-center space-x-1.5 px-5 py-2.5 bg-gradient-to-r from-[#ff6a1f] to-[#ff4a03] hover:from-[#ff4a03] hover:to-[#d63d04] text-white font-bold rounded-xl text-xs transition-all shadow-[0_10px_24px_rgba(255,106,31,0.22)] active:scale-95"
                        >
                          <Play className="w-3 h-3 shrink-0" />
                          <span>Submit Assessment</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* 2. CHAT BUBBLE CONSOLE AREA */}
              <div className="flex-1 overflow-y-auto space-y-4 pr-2 mt-4 max-h-[55vh] border-b border-slate-200 pb-4 bg-transparent rounded-2xl px-3 py-4">
                {messages.map((m, idx) => (
                  <ChatBubble key={idx} sender={m.sender} text={m.text} />
                ))}
                {isAgentTyping && <ChatBubble sender="ai" isTyping />}
                <div ref={chatEndRef}></div>
              </div>

              {/* 3. CONTROLS / INPUT PANEL */}
              <div className="mt-4 pt-2 shrink-0">
                {!isTesting && (
                  <>
                    {profileStep === 'ready' && (
                      <div className="flex justify-center mb-4">
                        <button
                          onClick={() => setShowRules(true)}
                          className="flex items-center space-x-2 px-6 py-3 bg-gradient-to-r from-[#ff6a1f] to-[#ff4a03] hover:from-[#ff4a03] hover:to-[#d63d04] text-white font-semibold rounded-xl transition-all shadow-[0_12px_28px_rgba(255,106,31,0.24)]"
                        >
                          <Play className="w-4 h-4" />
                          <span>Start Fullscreen Assessment</span>
                        </button>
                      </div>
                    )}

                    {profileStep !== 'ready' && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          handleProfileInputSubmit(inputVal);
                        }}
                        className="flex space-x-3 bg-white border border-slate-200 rounded-2xl p-2 items-center shadow-sm"
                      >
                        <input
                          type="text"
                          value={inputVal}
                          onChange={(e) => setInputVal(e.target.value)}
                          placeholder="Type your response here..."
                          className="flex-1 bg-transparent py-2 px-3 text-sm focus:outline-none text-slate-950 placeholder-slate-400 cursor-text"
                          style={{ caretColor: '#ff6a1f' }}
                        />
                        <button
                          type="submit"
                          className="p-2.5 bg-gradient-to-r from-[#ff6a1f] to-[#ff4a03] hover:from-[#ff4a03] hover:to-[#d63d04] text-white rounded-xl transition-colors active:scale-95 shrink-0 shadow-[0_8px_18px_rgba(255,106,31,0.20)]"
                        >
                          <Send className="w-4 h-4" />
                        </button>
                      </form>
                    )}
                  </>
                )}

                {/* Active exam questions input rendering */}
                {isTesting && currentQuestion && (
                  <div className="bg-white border border-slate-200 p-5 rounded-2xl space-y-5 relative shadow-sm shrink-0">
                    {/* Question display */}
                    <div className="space-y-1">
                      <span className="text-[10px] text-[#ff6a1f] font-bold uppercase tracking-wider">Active Question</span>
                      <p className="text-sm font-bold text-slate-950 leading-relaxed">{currentQuestion.text}</p>
                    </div>

                    {/* MCQ Options rendering */}
                    {currentQuestion.type === 'MCQ' && (
                      <div className="grid grid-cols-1 gap-3">
                        {currentQuestion.options.map((opt, idx) => (
                          <label
                            key={idx}
                            className={`flex items-center space-x-3 p-3 rounded-xl border text-sm cursor-pointer transition-all
                              ${selectedAnswer === opt
                                ? 'bg-[#fff4eb] border-[#ff6a1f] text-slate-950 shadow-sm'
                                : 'bg-white border-slate-200 hover:border-[#ff8b4d] text-slate-700'}`}
                          >
                            <input
                              type="radio"
                              name="mcq"
                              value={opt}
                              checked={selectedAnswer === opt}
                              onChange={() => setSelectedAnswer(opt)}
                              className="sr-only"
                            />
                            <span className="font-mono text-xs w-5 h-5 flex items-center justify-center bg-slate-100 border border-slate-200 rounded-full text-slate-700">{String.fromCharCode(65 + idx)}</span>
                            <span>{opt}</span>
                          </label>
                        ))}
                      </div>
                    )}

                    {/* MSQ Options rendering */}
                    {currentQuestion.type === 'MSQ' && (
                      <div className="grid grid-cols-1 gap-3">
                        {currentQuestion.options.map((opt, idx) => {
                          const ansArray = Array.isArray(selectedAnswer) ? selectedAnswer : [];
                          const isSelected = ansArray.includes(opt);

                          const handleCheckboxToggle = () => {
                            if (isSelected) {
                              setSelectedAnswer(ansArray.filter(v => v !== opt));
                            } else {
                              setSelectedAnswer([...ansArray, opt]);
                            }
                          };

                          return (
                            <label
                              key={idx}
                              className={`flex items-center space-x-3 p-3 rounded-xl border text-sm cursor-pointer transition-all
                                ${isSelected
                                  ? 'bg-[#fff4eb] border-[#ff6a1f] text-slate-950 shadow-sm'
                                  : 'bg-white border-slate-200 hover:border-[#ff8b4d] text-slate-700'}`}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={handleCheckboxToggle}
                                className="sr-only"
                              />
                              <span className="font-mono text-xs w-5 h-5 flex items-center justify-center bg-slate-100 border border-slate-200 rounded-full text-slate-700">{String.fromCharCode(65 + idx)}</span>
                              <span>{opt}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}

                    {/* Short Answer text block rendering */}
                    {currentQuestion.type === 'Short' && (
                      <div className="relative">
                        <input
                          type="text"
                          value={selectedAnswer || ''}
                          onChange={(e) => setSelectedAnswer(e.target.value)}
                          placeholder="Type your short answer response..."
                          className="w-full bg-white border border-slate-200 rounded-xl py-3 px-4 text-sm focus:outline-none focus:border-[#ff6a1f] text-slate-950 placeholder-slate-400"
                          style={{ caretColor: '#ff6a1f' }}
                        />
                      </div>
                    )}

                    {/* Long, Scenario, Logical, Analytical Text Area rendering */}
                    {['Long', 'Scenario', 'Logical', 'Analytical'].includes(currentQuestion.type) && (() => {
                      const isCodeFocused = currentQuestion.type === 'Scenario' && (
                        currentQuestion.topic?.toLowerCase().includes('coding') ||
                        currentQuestion.topic?.toLowerCase().includes('code') ||
                        currentQuestion.text?.toLowerCase().includes('write code') ||
                        currentQuestion.text?.toLowerCase().includes('api') ||
                        currentQuestion.text?.toLowerCase().includes('sdk')
                      );
                      return (
                        <div className="relative">
                          <textarea
                            rows={5}
                            value={selectedAnswer || ''}
                            onChange={(e) => setSelectedAnswer(e.target.value)}
                            placeholder={isCodeFocused ? "// Write your code or configuration here...\n" : "Write your comprehensive analysis response here... (Pseudocode or detailed steps welcome)"}
                            className={`w-full border rounded-xl py-3 px-4 text-sm focus:outline-none focus:border-[#ff6a1f] resize-none
                              ${isCodeFocused 
                                ? 'bg-slate-950 border-slate-800 text-emerald-400 font-mono' 
                                : 'bg-white border-slate-200 text-slate-950 placeholder-slate-400'}`}
                            style={{ caretColor: '#ff6a1f' }}
                          />
                        </div>
                      );
                    })()}

                    {/* Submission button */}
                    <div className="flex justify-between items-center pt-2 border-t border-slate-200">
                      {questionNum < totalQuestions ? (
                        <>
                          <button
                            type="button"
                            onClick={handleSubmitExamClick}
                            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl text-xs transition-colors"
                          >
                            Submit Exam
                          </button>
                          <button
                            type="button"
                            onClick={handleSubmitActiveAnswer}
                            className="flex items-center space-x-1.5 px-5 py-2.5 bg-gradient-to-r from-[#ff6a1f] to-[#ff4a03] hover:from-[#ff4a03] hover:to-[#d63d04] text-white font-semibold rounded-xl text-xs transition-all shadow-[0_10px_24px_rgba(255,106,31,0.22)] active:scale-95"
                          >
                            <span>Next Question</span>
                            <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={handleSubmitExamClick}
                          className="w-full flex items-center justify-center space-x-1.5 px-5 py-2.5 bg-gradient-to-r from-[#ff6a1f] to-[#ff4a03] hover:from-[#ff4a03] hover:to-[#d63d04] text-white font-bold rounded-xl text-xs transition-all shadow-[0_10px_24px_rgba(255,106,31,0.22)] active:scale-95"
                        >
                          <Play className="w-3 h-3 shrink-0" />
                          <span>Submit Assessment</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* 5. SUBMIT CONFIRMATION MODAL */}
          {showSubmitConfirmModal && (
            <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
              <div className="bg-white border border-slate-200 p-6 rounded-2xl max-w-md w-full space-y-4 shadow-2xl">
                <div className="flex items-center space-x-3 text-red-500">
                  <AlertTriangle className="w-8 h-8 shrink-0" />
                  <h3 className="text-lg font-bold text-slate-950">
                    {questionNum < totalQuestions ? 'Terminate & Submit Assessment?' : 'Submit Assessment?'}
                  </h3>
                </div>

                <p className="text-xs text-slate-600 leading-relaxed">
                  {questionNum < totalQuestions
                    ? `Warning: You have only answered ${questionNum} out of ${totalQuestions} questions. Submitting now will prematurely terminate your exam, and this attempt will be permanently marked as incomplete/terminated.`
                    : `You have completed all ${totalQuestions} questions. Are you sure you want to submit your answers for final AI grading?`}
                </p>

                <div className="flex justify-end space-x-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowSubmitConfirmModal(false)}
                    className="px-4 py-2 border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold rounded-xl text-xs transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={questionNum < totalQuestions ? handleTerminateExamPrematurely : handleFinalSuccessfulSubmit}
                    className="px-5 py-2 bg-gradient-to-r from-[#ff6a1f] to-[#ff4a03] hover:from-[#ff4a03] hover:to-[#d63d04] text-white font-semibold rounded-xl text-xs transition-all shadow-[0_8px_18px_rgba(255,106,31,0.22)]"
                  >
                    {questionNum < totalQuestions ? 'Yes, Terminate & Submit' : 'Yes, Submit Exam'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 4. SECURITY WARNING MODAL */}
          {showWarningModal && (
            <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 p-4">
              <div className="bg-white border border-slate-200 p-6 rounded-2xl max-w-sm w-full space-y-4 shadow-2xl text-center">
                <AlertTriangle className="w-12 h-12 text-yellow-500 mx-auto animate-pulse" />
                <h3 className="text-lg font-bold text-slate-950">Security Alert</h3>
                <p className="text-xs text-slate-600 leading-relaxed">{warningMessage}</p>
                <div className="text-xs text-red-500 font-bold uppercase tracking-wider">
                  Violations: {cheatingCount} / 3
                </div>
                <button
                  onClick={() => setShowWarningModal(false)}
                  className="w-full py-2 bg-gradient-to-r from-[#ff6a1f] to-[#ff4a03] hover:from-[#ff4a03] hover:to-[#d63d04] text-white font-semibold rounded-xl text-xs transition-all shadow-[0_10px_24px_rgba(255,106,31,0.20)]"
                >
                  Acknowledge & Resume
                </button>
              </div>
            </div>
          )}
        </>
      )}

    </div>
  );
};

export default AssessmentPage;
