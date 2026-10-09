require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const { connectDB, getIsConnected } = require('./config/db');
const Submission = require('./models/Submission');
const { MASTER_ROSTER, isValidRollNumber } = require('./utils/roster');

const app = express();
const PORT = process.env.PORT || 3000;

// Local JSON File Store Path (with Vercel /tmp fallback)
const os = require('os');
const DATA_DIR = process.env.VERCEL ? os.tmpdir() : path.join(__dirname, 'data');
const LOCAL_STORE_FILE = path.join(DATA_DIR, 'submissions.json');

try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(LOCAL_STORE_FILE)) {
    fs.writeFileSync(LOCAL_STORE_FILE, JSON.stringify([]), 'utf8');
  }
} catch (fsErr) {
  console.warn('[FS Warning]', fsErr.message);
}

function readLocalSubmissions() {
  try {
    if (fs.existsSync(LOCAL_STORE_FILE)) {
      const raw = fs.readFileSync(LOCAL_STORE_FILE, 'utf8');
      return JSON.parse(raw);
    }
    return [];
  } catch (err) {
    return [];
  }
}

function writeLocalSubmissions(data) {
  try {
    fs.writeFileSync(LOCAL_STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write local submissions JSON:', err);
  }
}

// Connect to MongoDB
connectDB();

// Middleware
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer Setup
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('REJECTED: Only PDF format files are allowed!'), false);
    }
  }
});

// Google Drive Folder IDs
const DRIVE_FOLDERS = {
  "APSSDC": { id: "18swFrqVgZhPOOybWs4SnVD1m_zpu2E29", url: "https://drive.google.com/drive/folders/18swFrqVgZhPOOybWs4SnVD1m_zpu2E29" },
  "APSCHE": { id: "1_3I_QADN7cx238--wPgpT58HsG_-mZ2_", url: "https://drive.google.com/drive/folders/1_3I_QADN7cx238--wPgpT58HsG_-mZ2_" },
  "OTHER AICTE CERTIFICATES": { id: "1_NfcnPoxEfJ7eufTwKKM0b47TiWI--X7", url: "https://drive.google.com/drive/folders/1_NfcnPoxEfJ7eufTwKKM0b47TiWI--X7" }
};

/**
 * Certificate Upload Route
 */
app.post('/api/upload', upload.single('certificatePdf'), async (req, res) => {
  try {
    const { name, rollNo, course, courseName } = req.body;
    const file = req.file;

    // 1. Required fields
    if (!name || !rollNo || !course || !courseName) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: Name, Roll No, Platform, and Course Name are required."
      });
    }

    if (!file) {
      return res.status(400).json({
        success: false,
        error: "No PDF file attached. Please select a valid PDF certificate."
      });
    }

    // 2. Valid course platform check
    if (!DRIVE_FOLDERS[course]) {
      return res.status(400).json({
        success: false,
        error: `Invalid platform selection. Must be one of: APSSDC, APSCHE, OTHER AICTE CERTIFICATES.`
      });
    }

    // 3. Roll Number Format & Master Roster Validation
    const rollCheck = isValidRollNumber(rollNo);
    if (!rollCheck.valid) {
      return res.status(400).json({
        success: false,
        error: rollCheck.message
      });
    }
    const cleanRollNo = rollCheck.rollNo;

    // 4. One member upload once validation
    let existing = null;
    if (getIsConnected()) {
      existing = await Submission.findOne({ rollNo: cleanRollNo });
    }
    if (!existing) {
      const localData = readLocalSubmissions();
      existing = localData.find(s => s.rollNo.toUpperCase() === cleanRollNo);
    }

    if (existing) {
      return res.status(400).json({
        success: false,
        error: `REJECTED: Roll Number ${cleanRollNo} has ALREADY uploaded a certificate. (One member upload once rule)`
      });
    }

    // 5. File Naming format check: ROLLNUMBER_COURSENAME.pdf
    const cleanCourseName = courseName.trim().replace(/[/\\?%*:|"<>]/g, '');
    const expectedBaseName = `${cleanRollNo}_${cleanCourseName}`;
    const expectedFileName = `${expectedBaseName}.pdf`;
    const originalFileName = file.originalname;
    const cleanUploadedName = originalFileName.replace(/\.pdf$/i, '').trim();

    if (cleanUploadedName !== expectedBaseName) {
      return res.status(400).json({
        success: false,
        error: `REJECTED: File naming format invalid! File MUST be named "${expectedFileName}". Received: "${originalFileName}".`
      });
    }

    // Forward to Google Apps Script Web App
    let driveFileUrl = DRIVE_FOLDERS[course].url;
    let driveFileId = '';
    const gasUrl = (process.env.GAS_WEB_APP_URL || '').trim();

    if (gasUrl) {
      try {
        const fileBase64 = file.buffer.toString('base64');
        const payload = JSON.stringify({
          name: name.trim(),
          rollNo: cleanRollNo,
          course: course,
          courseName: cleanCourseName,
          fileName: expectedFileName,
          fileData: fileBase64,
          mimeType: file.mimetype
        });

        const gasRes = await axios.post(gasUrl, payload, {
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          maxRedirects: 10,
          timeout: 25000
        });

        if (gasRes.data && gasRes.data.success) {
          driveFileUrl = gasRes.data.fileUrl || driveFileUrl;
          driveFileId = gasRes.data.fileId || '';
        } else if (gasRes.data && gasRes.data.error) {
          return res.status(400).json({
            success: false,
            error: `Google Drive Error: ${gasRes.data.error}`
          });
        } else {
          return res.status(400).json({
            success: false,
            error: "Google Drive Upload failed: Web App returned invalid response. Ensure Deployment Access is set to 'Anyone'."
          });
        }
      } catch (gasErr) {
        console.error('[GAS Upload Error]', gasErr.message);
        if (gasErr.response && gasErr.response.status === 401) {
          return res.status(400).json({
            success: false,
            error: "Google Drive 401 Unauthorized: Your Google Apps Script Web App access is set to 'Only myself'. Change 'Who has access' to 'Anyone' in Google Apps Script deployment settings!"
          });
        }
        return res.status(400).json({
          success: false,
          error: `Google Drive Upload Exception: ${gasErr.message}. Ensure Google Script is deployed with 'Who has access: Anyone'.`
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        error: "Google Apps Script Web App URL is missing in .env file (GAS_WEB_APP_URL)."
      });
    }

    // Submission Object
    const submissionData = {
      rollNo: cleanRollNo,
      name: name.trim(),
      course: course,
      courseName: cleanCourseName,
      fileName: expectedFileName,
      driveFolderId: DRIVE_FOLDERS[course].id,
      driveFileUrl: driveFileUrl,
      driveFileId: driveFileId,
      uploadedAt: new Date().toISOString()
    };

    // Save to Local JSON file
    const localStore = readLocalSubmissions();
    localStore.push(submissionData);
    writeLocalSubmissions(localStore);

    // Save to MongoDB if connected
    if (getIsConnected()) {
      try {
        const doc = new Submission(submissionData);
        await doc.save();
      } catch (dbErr) {
        console.warn('[MongoDB Save Notice]', dbErr.message);
      }
    }

    return res.json({
      success: true,
      message: `Certificate uploaded successfully to Google Drive for ${cleanRollNo}!`,
      data: submissionData
    });

  } catch (err) {
    console.error('[Upload API Error]', err);
    return res.status(500).json({
      success: false,
      error: `Server error during upload: ${err.message}`
    });
  }
});

/**
 * Status & Roster Analytics Route
 */
app.get('/api/status', async (req, res) => {
  try {
    let submissions = readLocalSubmissions();

    if (getIsConnected()) {
      try {
        const dbDocs = await Submission.find().sort({ uploadedAt: -1 }).lean();
        if (dbDocs && dbDocs.length > 0) {
          submissions = dbDocs;
        }
      } catch (err) {
        console.warn('[MongoDB Status Read Notice]', err.message);
      }
    }

    const uploadedRolls = new Set(submissions.map(s => s.rollNo.toUpperCase()));
    const pendingRolls = MASTER_ROSTER.filter(roll => !uploadedRolls.has(roll));

    const totalStudents = MASTER_ROSTER.length;
    const uploadedCount = uploadedRolls.size;
    const pendingCount = pendingRolls.length;
    const percentage = totalStudents > 0 ? Math.round((uploadedCount / totalStudents) * 100) : 0;

    return res.json({
      stats: {
        total: totalStudents,
        uploaded: uploadedCount,
        pending: pendingCount,
        percentage: percentage,
        mongoConnected: getIsConnected()
      },
      submissions: submissions,
      pendingList: pendingRolls
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: `Failed to fetch portal status: ${err.message}`
    });
  }
});

/**
 * Admin Submission Reset Route
 */
app.delete('/api/submission/:rollNo', async (req, res) => {
  try {
    const rollNo = req.params.rollNo.toUpperCase().trim();

    let localStore = readLocalSubmissions();
    localStore = localStore.filter(s => s.rollNo.toUpperCase() !== rollNo);
    writeLocalSubmissions(localStore);

    if (getIsConnected()) {
      await Submission.findOneAndDelete({ rollNo });
    }

    return res.json({
      success: true,
      message: `Submission for ${rollNo} reset successfully.`
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Fetch Google Script Source
 */
app.get('/api/script', (req, res) => {
  try {
    let scriptPath = path.join(__dirname, 'Code.gs');
    if (!fs.existsSync(scriptPath)) {
      scriptPath = path.join(__dirname, 'google-apps-script', 'Code.gs');
    }
    const code = fs.readFileSync(scriptPath, 'utf8');
    return res.json({ success: true, code });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Start Server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 Certificate Upload Server running on http://localhost:${PORT}`);
    console.log(`📁 Master Roster Count: ${MASTER_ROSTER.length} students`);
    console.log(`====================================================`);
  });
}

module.exports = app;
