require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const mongoose = require('mongoose');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

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
    sleep: String,
    soreness: Number,
    energy: Number,
    motivation: Number
}, { timestamps: true });
const DayLog = mongoose.model('DayLog', daySchema);

const tokenSchema = new mongoose.Schema({
    identifier: { type: String, default: 'primary_user', unique: true },
    refreshToken: String
});
const AuthToken = mongoose.model('AuthToken', tokenSchema);

const logisticsTokenSchema = new mongoose.Schema({
    identifier: { type: String, default: 'primary_user', unique: true },
    refreshToken: String
});
const LogisticsToken = mongoose.model('LogisticsToken', logisticsTokenSchema);

const portfolioSchema = new mongoose.Schema({
    identifier: { type: String, default: 'primary_user', unique: true },
    holdings: Array,
    totalValue: Number
});
const Portfolio = mongoose.model('Portfolio', portfolioSchema);

const journalSchema = new mongoose.Schema({
    identifier: { type: String, default: 'primary_user' },
    date: { type: String, required: true },
    habits: { type: Object, default: {} },
    reflection: { type: String, default: '' },
    title: { type: String, default: 'Daily Tactical Log' } // NEW: Marvin's Auto-Title
});
const JournalLog = mongoose.model('JournalLog', journalSchema);

const settingsSchema = new mongoose.Schema({
    identifier: { type: String, default: 'primary_user', unique: true },
    habitList: { type: Array, default: ['Hydration (1 Gallon)', '10 Mins Match Visualization', 'Mobility / Deep Stretching', 'Read 15 Pages'] }
});
const Settings = mongoose.model('Settings', settingsSchema);

// --- 🔐 PERSISTENT TOKEN MANAGEMENT ---
let storedAccessToken = null;
let tokenExpiresAt = null;

async function getSavedRefreshToken() {
    try {
        const doc = await AuthToken.findOne({ identifier: 'primary_user' });
        return doc ? doc.refreshToken : null;
    } catch (err) {
        console.error("Error reading token from DB:", err);
        return null;
    }
}

async function saveRefreshToken(token) {
    try {
        await AuthToken.findOneAndUpdate(
            { identifier: 'primary_user' },
            { refreshToken: token },
            { upsert: true, new: true }
        );
        console.log("💾 Refresh token securely saved to MongoDB Cloud!");
    } catch (err) {
        console.error("Error saving token to DB:", err);
    }
}

async function getValidAccessToken() {
    if (storedAccessToken && tokenExpiresAt && Date.now() < tokenExpiresAt - 120000) {
        return storedAccessToken;
    }

    const savedRefreshToken = await getSavedRefreshToken();

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
                await saveRefreshToken(response.data.refresh_token);
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

// --- 🏫 SCHOOL TOKEN MANAGEMENT ---
let storedLogisticsToken = null;
let logisticsTokenExpiresAt = null;

async function getSavedLogisticsRefreshToken() {
    try {
        const doc = await LogisticsToken.findOne({ identifier: 'primary_user' });
        return doc ? doc.refreshToken : null;
    } catch (err) { return null; }
}

async function saveLogisticsRefreshToken(token) {
    try {
        await LogisticsToken.findOneAndUpdate(
            { identifier: 'primary_user' },
            { refreshToken: token },
            { upsert: true, new: true }
        );
    } catch (err) { console.error("Error saving logistics token", err); }
}

async function getValidLogisticsToken() {
    if (storedLogisticsToken && logisticsTokenExpiresAt && Date.now() < logisticsTokenExpiresAt - 120000) {
        return storedLogisticsToken;
    }
    const savedRefreshToken = await getSavedLogisticsRefreshToken();
    if (savedRefreshToken) {
        try {
            const response = await axios.post('https://oauth2.googleapis.com/token', {
                client_id: process.env.FITBIT_CLIENT_ID,
                client_secret: process.env.FITBIT_CLIENT_SECRET,
                refresh_token: savedRefreshToken,
                grant_type: 'refresh_token'
            });
            storedLogisticsToken = response.data.access_token;
            const expiresIn = response.data.expires_in || 3600;
            logisticsTokenExpiresAt = Date.now() + (expiresIn * 1000);
            if (response.data.refresh_token) await saveLogisticsRefreshToken(response.data.refresh_token);
            return storedLogisticsToken;
        } catch (error) { throw new Error("School token refresh failed."); }
    }
    throw new Error("No school credentials found.");
}

// --- 🔐 AUTHENTICATION ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

app.get('/api/fitbit/auth', (req, res) => {
    // STRICTLY HEALTH SCOPES ONLY
    const rawScopes = "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly https://www.googleapis.com/auth/googlehealth.sleep.readonly";
    const encodedScopes = encodeURIComponent(rawScopes);
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${process.env.FITBIT_CLIENT_ID}&redirect_uri=${BASE_URL}/callback&scope=${encodedScopes}&access_type=offline&prompt=consent`;    
    res.redirect(authUrl);
});

// NEW: STRICTLY SCHOOL SCOPES
app.get('/api/logistics/auth', (req, res) => {
    const rawScopes = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly https://www.googleapis.com/auth/gmail.readonly";
    const encodedScopes = encodeURIComponent(rawScopes);
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${process.env.FITBIT_CLIENT_ID}&redirect_uri=${BASE_URL}/logistics/callback&scope=${encodedScopes}&access_type=offline&prompt=consent`;    
    res.redirect(authUrl);
});

app.get('/logistics/callback', async (req, res) => {
    const authCode = req.query.code;
    if (!authCode) return res.send('Error: No code provided from Google');

    try {
        const response = await axios.post('https://oauth2.googleapis.com/token', {
            client_id: process.env.FITBIT_CLIENT_ID,
            client_secret: process.env.FITBIT_CLIENT_SECRET,
            code: authCode,
            grant_type: 'authorization_code',
            redirect_uri: `${BASE_URL}/logistics/callback`
        });
        
        storedLogisticsToken = response.data.access_token;
        if (response.data.refresh_token) await saveLogisticsRefreshToken(response.data.refresh_token);
        
        const expiresIn = response.data.expires_in || 3600;
        logisticsTokenExpiresAt = Date.now() + (expiresIn * 1000);

        res.redirect('/dashboard.html?tab=logistics');
    } catch (error) {
        console.error("School Auth Error:", error.response?.data || error.message);
        res.status(500).send("School Authentication failed.");
    }
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
            await saveRefreshToken(response.data.refresh_token);
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

// --- 📅 CENTRAL NERVOUS SYSTEM (LOGISTICS HUB) ---
app.get('/api/logistics', async (req, res) => {
    try {
        const accessToken = await getValidAccessToken();
        const headers = { headers: { 'Authorization': `Bearer ${accessToken}` } };

        // 1. Fetch Calendar Events (Next 7 days)
        const timeMin = new Date().toISOString();
        const timeMax = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const calReq = axios.get(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`, headers);

        // 2. Fetch Active Classroom Courses
        const coursesReq = axios.get('https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE', headers);

        // Execute both calls simultaneously for speed
        const [calRes, coursesRes] = await Promise.allSettled([calReq, coursesReq]);

        let calendarEvents = calRes.status === 'fulfilled' ? calRes.value.data.items || [] : [];
        let courses = coursesRes.status === 'fulfilled' ? coursesRes.value.data.courses || [] : [];
        
        let assignments = [];
        // 3. Fetch homework for up to 3 active courses to keep the system lightning fast
        if (courses.length > 0) {
            const hwRequests = courses.slice(0, 3).map(c => 
                axios.get(`https://classroom.googleapis.com/v1/courses/${c.id}/courseWork`, headers)
            );
            const hwResponses = await Promise.allSettled(hwRequests);
            hwResponses.forEach((hwRes, idx) => {
                if (hwRes.status === 'fulfilled' && hwRes.value.data.courseWork) {
                    const courseName = courses[idx].name;
                    hwRes.value.data.courseWork.forEach(work => {
                        // Only add assignments that haven't been completed yet
                        assignments.push({ course: courseName, title: work.title, due: work.dueDate });
                    });
                }
            });
        }

        res.json({ calendar: calendarEvents, assignments });

    } catch (error) {
        console.error("Logistics API Error:", error.message);
        res.status(500).json({ error: "Marvin cannot access Google Logistics right now." });
    }
});

// --- 🗄️ DATABASE ROUTES (MONGODB) ---
app.post('/api/save-day', async (req, res) => {
    try {
        let payload = req.body;
        if (!payload.date) return res.status(400).json({ error: "Date is required" });

        // 🛡️ STRICT SANITIZATION: Strip out nulls, undefined, and empty placeholders
        const cleanPayload = {};
        for (let key in payload) {
            const val = payload[key];
            if (val !== '--' && val !== null && val !== undefined && val !== '') {
                // Cast known numeric fields to prevent NaN DB corruption
                if (['healthScore', 'recovery', 'strain', 'steps', 'soreness', 'energy', 'motivation'].includes(key)) {
                    const parsed = Number(val);
                    if (!isNaN(parsed)) cleanPayload[key] = parsed;
                } else {
                    cleanPayload[key] = val;
                }
            }
        }

        // 🔄 UPSERT WITH MERGE: Only updates the safe, explicitly provided fields
        const updatedLog = await DayLog.findOneAndUpdate(
            { date: cleanPayload.date },
            { $set: cleanPayload },
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

// --- 📈 PORTFOLIO ROUTES ---
app.get('/api/portfolio', async (req, res) => {
    try {
        const doc = await Portfolio.findOne({ identifier: 'primary_user' });
        res.json(doc ? { holdings: doc.holdings, totalValue: doc.totalValue } : { holdings: [], totalValue: 0 });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch portfolio" });
    }
});

app.post('/api/portfolio', async (req, res) => {
    try {
        const { holdings, totalValue } = req.body;
        await Portfolio.findOneAndUpdate(
            { identifier: 'primary_user' },
            { holdings, totalValue },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to save portfolio" });
    }
});

// --- ⚙️ DYNAMIC HABIT & JOURNAL ROUTES ---
app.get('/api/habits/master', async (req, res) => {
    try {
        const doc = await Settings.findOne({ identifier: 'primary_user' });
        // If the user has saved settings, return them. Otherwise, return the defaults.
        if (doc && doc.habitList && doc.habitList.length > 0) {
            res.json(doc.habitList);
        } else {
            res.json([
                'Hydration (1 Gallon)', 
                '10 Mins Match Visualization', 
                'Mobility / Deep Stretching', 
                'Read 15 Pages'
            ]);
        }
    } catch (err) { 
        console.error("Habit Fetch Error:", err);
        res.status(500).json({ error: "Failed to fetch habits" }); 
    }
});

app.post('/api/habits/master', async (req, res) => {
    try {
        await Settings.findOneAndUpdate(
            { identifier: 'primary_user' },
            { $set: { habitList: req.body.habitList } }, // Forces MongoDB to overwrite the array
            { upsert: true }
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Failed to save habits" }); }
});


app.get('/api/journal', async (req, res) => {
    try {
        const { date } = req.query;
        const doc = await JournalLog.findOne({ identifier: 'primary_user', date: date });
        res.json(doc || { habits: {}, reflection: '' });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch journal" });
    }
});

app.post('/api/journal', async (req, res) => {
    try {
        const { date, habits, reflection } = req.body;
        let title = "Daily Tactical Log";

        // Have Marvin auto-generate a title if you actually wrote a reflection
        if (reflection && reflection.trim().length > 5) {
            try {
                // Note: Make sure 'gemini-3.5-flash' is the correct model string for your API version
                const prompt = `You are Marvin. Read this athlete's daily journal: "${reflection}". Generate a punchy, 3-to-4 word title summarizing it. Return ONLY the title.`;
                const response = await ai.models.generateContent({
                    model: 'gemini-1.5-flash', // Updated to standard Flash model, change back if you have specialized access
                    contents: prompt,
                });
                title = response.text.replace(/["*]/g, '').trim();
            } catch (err) { 
                console.error("Marvin Title Gen Offline", err); 
            }
        }

        await JournalLog.findOneAndUpdate(
            { identifier: 'primary_user', date: date },
            { $set: { habits, reflection, title } }, // Explicit $set ensures clean merging
            { upsert: true, new: true }
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Journal Save Error:", err);
        res.status(500).json({ error: "Failed to save journal" });
    }
});

app.get('/api/journal/history', async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30; 
        
        let history = await JournalLog.find({ identifier: 'primary_user' })
            .sort({ date: -1 })
            .limit(days === 0 ? 0 : days); 
            
        history = history.reverse(); 
        res.json(history);
    } catch (err) { res.status(500).json({ error: "Failed to fetch journal history" }); }
});

// --- 📈 LIVE STOCK MARKET ROUTE (FIREWALL BYPASS) ---
app.get('/api/stocks', async (req, res) => {
    try {
        const symbolsStr = req.query.symbols; 
        if (!symbolsStr) return res.json({});
        
        const symbols = symbolsStr.split(',');
        const data = {};
        
        const requests = symbols.map(sym => 
            axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }).catch(() => null) 
        );

        const responses = await Promise.all(requests);
        
        responses.forEach((response, idx) => {
            if (response && response.data && response.data.chart && response.data.chart.result) {
                const meta = response.data.chart.result[0].meta;
                const price = meta.regularMarketPrice;
                const prevClose = meta.chartPreviousClose;
                
                const changePercent = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
                const changeAmount = prevClose ? (price - prevClose) : 0; 
                
                data[symbols[idx]] = { price, changePercent, changeAmount };
            }
        });

        res.json(data);
    } catch (error) {
        console.error("Stock API Error:", error.message);
        res.status(500).json({ error: "Failed to fetch market data" });
    }
});

// --- 🧠 MULTI-TOOL GEMINI ROUTE ---
app.post('/api/ai-coach', async (req, res) => {
    try {
        const { strain, recovery, healthScore, sleep, activeMins } = req.body;

        const systemPrompt = `You are Marvin, the central AI intelligence of this Life OS. Right now, you are acting as an elite sports scientist and tactical coach for a high-level 14-year-old youth soccer player. 
        Your job is to analyze their daily biometric data and provide a short, punchy 3-bullet-point protocol for their day.
        Tone: Intense, professional, scientifically accurate, and loyal to the user's success.
        
        Today's Data:
        - Strain Capacity Used: ${strain}%
        - Nervous System Recovery: ${recovery}%
        - Overall Health Score: ${healthScore}%
        - Last Night's Sleep: ${sleep}
        - Active Minutes: ${activeMins}m
        
        Based on this data, give them 3 actionable bullet points for today.`;

        const response = await ai.models.generateContent({
            model: 'gemini-3.5-flash',
            contents: systemPrompt,
        });

        res.json({ advice: response.text });

    } catch (error) {
        console.error("AI Agent Error:", error);
        res.status(500).json({ error: "Marvin is currently offline." });
    }
});

app.post('/api/gemini', async (req, res) => {
    try {
        const { task, content, contextData } = req.body;
        let systemPrompt = "";

        if (task === 'polish_text') {
            systemPrompt = "You are Marvin. Rewrite the following text to make it punchy, professional, and clear. Do not add any extra commentary, just return the polished text.";
        } else if (task === 'polish_plan') {
            systemPrompt = "You are Marvin. Optimize the following plan/schedule to make it highly efficient and realistic. Structure it clearly with bullet points. Only return the improved plan.";
        } else if (task === 'portfolio_chat') {
            systemPrompt = `You are Marvin, the central AI intelligence of this Life OS. Right now, you are acting as an elite quantitative analyst and wealth manager. 
            The user has uploaded their current Fidelity portfolio:
            ${JSON.stringify(contextData.portfolio, null, 2)}
            Total Portfolio Value: $${contextData.totalValue}
            
            CRITICAL RULES:
            1. "SPAXX" is a money market fund. Treat it entirely as CASH, not a stock.
            2. When the user asks for advice or a scan, analyze their specific holdings, sector exposure, and risk.
            3. Provide specific, actionable trade adjustments based on current macroeconomic trends.
            4. Tone should be sharp, professional, and decisive. If they refer to "Marvin", acknowledge it directly.`;
        } else if (task === 'general_chat') {
            systemPrompt = `You are Marvin, the central AI intelligence and tactical assistant integrated directly into this elite Life OS. 
        
            You have full, real-time visibility into the user's system right now. Here is their exact live data:
            ${JSON.stringify(contextData, null, 2)}
            
            CRITICAL RULES:
            1. Your name is Marvin. If the user says "Hey Marvin" or refers to you, respond naturally.
            2. When the user asks a question, ALWAYS base your answer on their live data. 
            - If they ask "Should I train hard?", look at their Strain, Recovery, and HRV.
            - If they ask "How am I doing today?", look at their completed tasks, Steps, and Phase of the day.
            
            Tone: Punchy, elite, scientific, and direct. Keep it short. Do not use Markdown bolding (**) in your responses, just plain text.`;
        } else if (task === 'mindset_chat') {
            systemPrompt = `You are Marvin, the central AI intelligence of this Life OS. Right now, you are acting as an elite sports psychologist coaching a highly driven 14-year-old student-athlete. 
            They have just submitted their daily journal and habit tracker.
            
            Their Journal: "${content}"
            Habits Completed Today: ${JSON.stringify(contextData.habits)}
            
            Analyze their mindset. Look for signs of burnout, anxiety, or hyper-focus. 
            Provide a short, punchy 3-bullet-point response giving them tactical mental advice for tomorrow. Keep it professional, intense, and encouraging. If they address you as Marvin, answer naturally.`;
        }

        const response = await ai.models.generateContent({
            model: 'gemini-3.5-flash',
            contents: `${systemPrompt}\n\nUser Input: ${content}`,
        });

        res.json({ reply: response.text });

    } catch (error) {
        console.error("Gemini API Error:", error);
        res.status(500).json({ error: "Marvin is currently offline." });
    }
});

app.listen(PORT, () => {
    console.log(`\n--- SYSTEM ONLINE ---`);
    console.log(`Server running at: http://localhost:${PORT}`);
});