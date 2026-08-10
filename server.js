require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs'); 
const mongoose = require('mongoose'); // Added Mongoose
const { GoogleGenAI } = require('@google/genai');
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const TOKEN_PATH = path.join(__dirname, 'tokens.json');

// --- 🗄️ CLOUD DATABASE SYSTEM (MONGODB) ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB Cloud Database'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err.message));

const daySchema = new mongoose.Schema({
    date: { type: String, required: true, unique: true },
    healthScore: Number,
    recovery: Number,
    strain: Number,
    steps: Number,
    sleep: String, // Changed to String!
    soreness: Number,
    energy: Number,
    motivation: Number
}, { timestamps: true });

const DayLog = mongoose.model('DayLog', daySchema);

// --- 🔐 PERSISTENT TOKEN MANAGEMENT ---
let storedAccessToken = null;
let tokenExpiresAt = null;

function getSavedRefreshToken() {
    if (fs.existsSync(TOKEN_PATH)) {
        const data = fs.readFileSync(TOKEN_PATH, 'utf8');
        return JSON.parse(data).refreshToken;
    }
    return null;
}

function saveRefreshToken(token) {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ refreshToken: token }));
}

async function getValidAccessToken() {
    if (storedAccessToken && tokenExpiresAt && Date.now() < tokenExpiresAt - 120000) {
        return storedAccessToken;
    }

    const savedRefreshToken = getSavedRefreshToken();

    if (savedRefreshToken) {
        try {
            console.log("🔄 Fetching a fresh access token in the background...");
            const response = await axios.post('https://oauth2.googleapis.com/token', {
                client_id: process.env.FITBIT_CLIENT_ID,
                client_secret: process.env.FITBIT_CLIENT_SECRET,
                refresh_token: savedRefreshToken,
                grant_type: 'refresh_token'
            });

            storedAccessToken = response.data.access_token;
            const expiresIn = response.data.expires_in || 3600;
            tokenExpiresAt = Date.now() + (expiresIn * 1000);

            if (response.data.refresh_token) {
                saveRefreshToken(response.data.refresh_token);
            }

            console.log("✅ Token successfully refreshed. System Online.");
            return storedAccessToken;
        } catch (error) {
            console.error("❌ Token Refresh Error:", error.response?.data || error.message);
            throw new Error("Token revoked or expired. Please re-authenticate.");
        }
    }

    throw new Error("No authentication credentials found. Please log in.");
}

// --- 🔐 AUTHENTICATION ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

app.get('/api/fitbit/auth', (req, res) => {
    const rawScopes = "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly https://www.googleapis.com/auth/googlehealth.sleep.readonly";
    const encodedScopes = encodeURIComponent(rawScopes);
    
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${process.env.FITBIT_CLIENT_ID}&redirect_uri=${BASE_URL}/callback&scope=${encodedScopes}&access_type=offline&prompt=consent`;    res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
    const authCode = req.query.code;
    if (!authCode) return res.send('Error: No code provided from Google');

    try {
        const response = await axios.post('https://oauth2.googleapis.com/token', {
            client_id: process.env.FITBIT_CLIENT_ID,
            client_secret: process.env.FITBIT_CLIENT_SECRET,
            code: authCode,
            grant_type: 'authorization_code',
            redirect_uri: `${BASE_URL}/callback`
        });
        
        storedAccessToken = response.data.access_token;
        
        if (response.data.refresh_token) {
            saveRefreshToken(response.data.refresh_token);
            console.log("💾 Refresh token permanently saved to tokens.json");
        }
        
        const expiresIn = response.data.expires_in || 3600;
        tokenExpiresAt = Date.now() + (expiresIn * 1000);

        res.redirect('/dashboard.html?tab=health');
    } catch (error) {
        console.error("Auth Error:", error.response?.data || error.message);
        res.status(500).send("Authentication failed.");
    }
});

// --- ⚽ ELITE SOCCER HEALTH ALGORITHM ROUTE ---
app.get('/api/health-data', async (req, res) => {
    try {
        const accessToken = await getValidAccessToken();

        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const startTime = startOfToday.toISOString();
        const endTime = now.toISOString();

        const d = new Date();
        d.setDate(d.getDate() - 3);
        const filterDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

        const rhrFilter = `daily_resting_heart_rate.date >= "${filterDateStr}"`;
        const hrvFilter = `daily_heart_rate_variability.date >= "${filterDateStr}"`;
        const spo2Filter = `daily_oxygen_saturation.date >= "${filterDateStr}"`;

        const apiOptions = { headers: { 'Authorization': `Bearer ${accessToken}` } };
        const rollUpHeaders = { headers: { ...apiOptions.headers, 'Content-Type': 'application/json' } };
        
        const rollUpBody = { "range": { "startTime": startTime, "endTime": endTime }, "windowSize": "3600s" };

        const results = await Promise.allSettled([
            axios.post('https://health.googleapis.com/v4/users/me/dataTypes/steps/dataPoints:rollUp', rollUpBody, rollUpHeaders),
            axios.post('https://health.googleapis.com/v4/users/me/dataTypes/active-minutes/dataPoints:rollUp', rollUpBody, rollUpHeaders),
            axios.get(`https://health.googleapis.com/v4/users/me/dataTypes/daily-resting-heart-rate/dataPoints:reconcile?filter=${encodeURIComponent(rhrFilter)}`, apiOptions),
            axios.get(`https://health.googleapis.com/v4/users/me/dataTypes/daily-heart-rate-variability/dataPoints:reconcile?filter=${encodeURIComponent(hrvFilter)}`, apiOptions),
            axios.get(`https://health.googleapis.com/v4/users/me/dataTypes/daily-oxygen-saturation/dataPoints:reconcile?filter=${encodeURIComponent(spo2Filter)}`, apiOptions),
            axios.post('https://health.googleapis.com/v4/users/me/dataTypes/total-calories/dataPoints:rollUp', rollUpBody, rollUpHeaders),
            axios.get(`https://health.googleapis.com/v4/users/me/dataTypes/sleep/dataPoints:reconcile?pageSize=3`, apiOptions)
        ]);

        results.forEach((res, i) => {
            if (res.status === 'rejected') {
                console.error(`❌ Google API Call ${i + 1} Failed:`, res.reason.response?.data?.error?.message || res.reason.message);
            }
        });

        const [stepsRes, activeRes, rhrRes, hrvRes, spo2Res, calRes, sleepRes] = results;

        let steps = '--', calories = '--', activeMins = '--', sleepStr = '--', rhr = '--', hrv = '--', spo2 = '--';
        let stepsForMath = 0, calForMath = 0, activeForMath = 0, sleepMinsForMath = 0, hrvForMath = 0, rhrForMath = 0;
        let recovery = '--', strain = '--', healthScore = '--';

        const lastItem = arr => arr && arr.length > 0 ? arr[arr.length - 1] : null;
        const getNum = (val) => {
            if (!val) return 0;
            if (typeof val === 'number') return val;
            if (typeof val === 'string') return parseFloat(val) || 0;
            return 0;
        };

        if (stepsRes.status === 'fulfilled') {
            for (const p of stepsRes.value.data.rollupDataPoints || []) {
                stepsForMath += getNum(p.steps?.countSum || p.value || p.stepCount);
            }
            if (stepsForMath > 0) steps = stepsForMath.toLocaleString();
        }

        if (activeRes.status === 'fulfilled') {
            for (const p of activeRes.value.data.rollupDataPoints || []) {
                if (p.activeMinutes?.activeMinutesRollupByActivityLevel) {
                    for (const level of p.activeMinutes.activeMinutesRollupByActivityLevel) activeForMath += getNum(level.activeMinutesSum);
                } else {
                     activeForMath += getNum(p.activeMinutes?.countSum || p.value || p.duration);
                }
            }
            if (activeForMath > 0) activeMins = Math.round(activeForMath);
        }

        if (calRes.status === 'fulfilled') {
            for (const p of calRes.value.data.rollupDataPoints || []) {
                calForMath += getNum(p.totalCalories?.kcalSum || p.countSum || p.value);
            }
            if (calForMath > 0) calories = Math.round(calForMath).toLocaleString();
        }

        if (sleepRes.status === 'fulfilled') {
            const points = sleepRes.value.data.dataPoints || [];
            for (let i = points.length - 1; i >= 0; i--) {
                const s = points[i].sleep || points[i];
                let mins = getNum(s.summary?.minutesAsleep || s.minutesAsleep);
                if (mins === 0 && s.durationMillis) mins = s.durationMillis / 60000;
                if (mins > 0) {
                    sleepMinsForMath = Math.round(mins);
                    sleepStr = `${Math.floor(sleepMinsForMath / 60)}h ${sleepMinsForMath % 60}m`;
                    break; 
                }
            }
        }

        if (rhrRes.status === 'fulfilled') {
            rhrForMath = getNum(lastItem(rhrRes.value.data.dataPoints)?.dailyRestingHeartRate?.beatsPerMinute); 
            if (rhrForMath > 0) rhr = Math.round(rhrForMath);
        }
        if (hrvRes.status === 'fulfilled') {
            const hData = lastItem(hrvRes.value.data.dataPoints)?.dailyHeartRateVariability;
            hrvForMath = getNum(hData?.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds || hData?.averageHeartRateVariabilityMilliseconds);
            if (hrvForMath > 0) hrv = Math.round(hrvForMath);
        }
        if (spo2Res.status === 'fulfilled') {
            const sData = lastItem(spo2Res.value.data.dataPoints)?.dailyOxygenSaturation;
            const sVal = getNum(sData?.averagePercentage || sData?.percentage);
            if (sVal > 0) spo2 = Math.round(sVal);
        }

        if (stepsForMath > 0 || calForMath > 0 || activeForMath > 0) {
            let loadScore = (activeForMath * 1.0) + (calForMath * 0.04) + (stepsForMath / 350);
            strain = Math.max(Math.min(Math.round((loadScore / 350) * 100), 100), 1);
        }

        if (sleepMinsForMath > 0 && rhrForMath > 0 && hrvForMath > 0) {
            let sleepHours = sleepMinsForMath / 60;
            let sleepScore = Math.min((sleepHours / 9.0) * 45, 45);
            let hrvScore = Math.min((hrvForMath / 75) * 35, 35);
            let rhrPenalty = Math.max((rhrForMath - 52) * 1.8, 0);

            let rawRecovery = 10 + sleepScore + hrvScore - rhrPenalty;
            let recoveryNum = Math.min(Math.max(Math.round(rawRecovery), 1), 100);

            if (sleepMinsForMath < 360) recoveryNum = Math.min(recoveryNum, 35);
            else if (sleepMinsForMath < 450) recoveryNum = Math.min(recoveryNum, 60);

            recovery = recoveryNum;
        }

        if (recovery !== '--' && strain !== '--') {
            let strainNum = parseInt(strain, 10);
            let recNum = parseInt(recovery, 10);
            let overtrainingPenalty = 0;
            if (strainNum > 50 && recNum < 40) overtrainingPenalty = -18; 
            if (strainNum >= 40 && strainNum <= 80 && recNum >= 70) overtrainingPenalty = 8; 

            healthScore = Math.min(Math.max(Math.round((recNum * 0.65) + (strainNum * 0.35) + overtrainingPenalty), 1), 100);
        }

        res.json({ steps, calories, activeMins, sleep: sleepStr, rhr, hrv, spo2, recovery, strain, healthScore });

    } catch (error) {
        console.error("Health API Error:", error.message);
        res.status(500).json({ error: error.message || "Failed to fetch live health data" });
    }
});

// --- 🗄️ DATABASE ROUTES (MONGODB) ---
app.post('/api/save-day', async (req, res) => {
    try {
        let payload = req.body;
        if (!payload.date) return res.status(400).json({ error: "Date is required" });

        // --- THE FIX: Clean the data ---
        // Delete any keys where the value is "--" so Mongoose doesn't crash 
        // and we don't accidentally overwrite existing database fields with dashes.
        for (let key in payload) {
            if (payload[key] === '--') {
                delete payload[key];
            }
        }

        const updatedLog = await DayLog.findOneAndUpdate(
            { date: payload.date },
            { $set: payload },
            { upsert: true, new: true }
        );

        res.json({ success: true, data: updatedLog });
    } catch (err) {
        console.error("Database Save Error:", err);
        res.status(500).json({ error: "Failed to save data" });
    }
});

app.get('/api/history', async (req, res) => {
    try {
        const history = await DayLog.find().sort({ date: 1 }).limit(7);
        res.json(history);
    } catch (err) {
        console.error("Database Fetch Error:", err);
        res.status(500).json({ error: "Failed to fetch history" });
    }
});

// --- 🧠 MULTI-TOOL GEMINI ROUTE ---
app.post('/api/ai-coach', async (req, res) => {
    try {
        const { strain, recovery, healthScore, sleep, activeMins } = req.body;

        const systemPrompt = `You are an elite sports scientist and tactical coach for a high-level youth soccer player. 
        Your job is to analyze their daily biometric data and provide a short, punchy 3-bullet-point protocol for their day.
        Tone: Intense, professional, scientifically accurate, and encouraging.
        
        Today's Data:
        - Strain Capacity Used: ${strain}%
        - Nervous System Recovery: ${recovery}%
        - Overall Health Score: ${healthScore}%
        - Last Night's Sleep: ${sleep}
        - Active Minutes: ${activeMins}m
        
        Based on this data, give them 3 actionable bullet points for today.`;

        const response = await ai.models.generateContent({
            model: 'gemini-3.5-flash', // Fixed Model Version
            contents: systemPrompt,
        });

        res.json({ advice: response.text });

    } catch (error) {
        console.error("AI Agent Error:", error);
        res.status(500).json({ error: "Coach is currently offline." });
    }
});

app.post('/api/gemini', async (req, res) => {
    try {
        const { task, content, contextData } = req.body;
        let systemPrompt = "";

        if (task === 'polish_text') {
            systemPrompt = "You are an expert copyeditor. Rewrite the following text to make it punchy, professional, and clear. Do not add any extra commentary, just return the polished text.";
        } else if (task === 'polish_plan') {
            systemPrompt = "You are an elite productivity coach. Optimize the following plan/schedule to make it highly efficient and realistic. Structure it clearly with bullet points. Only return the improved plan.";
        } else if (task === 'general_chat') {
            systemPrompt = `You are an elite AI sports scientist and tactical assistant integrated directly into a high-performance athlete's dashboard. 
            
            You have full, real-time visibility into their system right now. Here is their exact live data:
            ${JSON.stringify(contextData, null, 2)}
            
            When the user asks a question, ALWAYS base your answer on this data. 
            - If they ask "Should I train hard?", look at their Strain, Recovery, and HRV.
            - If they ask "How am I doing today?", look at their completed tasks, Steps, and Phase of the day.
            - If they ask "What should I do before bed?", look at their Tomorrow Plan and Time Until Bed.
            
            Tone: Punchy, elite, scientific, and direct. Keep it short. Do not use Markdown bolding (**) in your responses, just plain text.`;
        }

        const response = await ai.models.generateContent({
            model: 'gemini-3.5-flash', // Fixed Model Version
            contents: `${systemPrompt}\n\nUser Input: ${content}`,
        });

        res.json({ reply: response.text });

    } catch (error) {
        console.error("Gemini API Error:", error);
        res.status(500).json({ error: "AI is currently offline." });
    }
});

app.listen(PORT, () => {
    console.log(`\n--- SYSTEM ONLINE ---`);
    console.log(`Server running at: http://localhost:${PORT}`);
});