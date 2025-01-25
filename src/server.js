// Because every bot needs a home, even if it's a dumpster fire
require('dotenv').config();
const express = require('express');
const { TwitterApi } = require('twitter-api-v2');
const { handleWhopGeneration } = require('./index');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// User context client for everything
const userClient = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET
});

// Create a list to store recent logs
const recentLogs = [];
const MAX_LOGS = 100;
const clients = new Set();

// Update the rate limit constants
const RATE_LIMITS = {
  currentInterval: 900000,  // Start at 15 minutes instead of 5
  maxInterval: 900000,      // Max 15 minutes
  resetTime: null,
  lastSearchTime: null,
  startupRetries: 0,
  maxStartupRetries: 3      // Reduced retries to avoid hitting limits
};

// Modify the log function to broadcast to clients
function log(type, message, data = {}) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    type,
    message,
    ...data
  };
  
  // Store log
  recentLogs.unshift(logEntry);
  if (recentLogs.length > MAX_LOGS) {
    recentLogs.pop();
  }

  // Broadcast to all connected clients
  const logString = JSON.stringify(logEntry);
  clients.forEach(client => client.write(`data: ${logString}\n\n`));
  
  // Still log to console for Render logs
  console.log(logString);
}

// Serve static dashboard
app.use(express.static(path.join(__dirname, 'public')));

// SSE endpoint for real-time logs
app.get('/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send all recent logs immediately
  recentLogs.forEach(logEntry => {
    res.write(`data: ${JSON.stringify(logEntry)}\n\n`);
  });

  // Add client to broadcast list
  clients.add(res);

  // Remove client when connection closes
  req.on('close', () => clients.delete(res));
});

// Keep track of processed tweets
const processedTweets = new Set();

// Add startup retry function
async function verifyCredentialsWithRetry() {
  try {
    // Add initial delay before first attempt
    await new Promise(resolve => setTimeout(resolve, 30000)); // 30 second initial delay
    
    const me = await userClient.v2.me();
    log('info', 'Twitter credentials verified', {
      id: me.data.id,
      username: me.data.username
    });
    return true;
  } catch (error) {
    if (error.code === 429) {
      RATE_LIMITS.startupRetries++;
      const resetTime = error.rateLimit?.reset 
        ? error.rateLimit.reset * 1000 
        : Date.now() + 900000; // 15 minute default

      const waitTime = Math.max(resetTime - Date.now(), 300000); // At least 5 minutes
      
      log('rate-limit', `Startup rate limited, retry ${RATE_LIMITS.startupRetries}/${RATE_LIMITS.maxStartupRetries}`, {
        waitTime: `${Math.floor(waitTime/60000)}m ${Math.floor((waitTime%60000)/1000)}s`,
        exactMs: waitTime,
        resetsAt: new Date(resetTime).toLocaleTimeString(),
        nextTryAt: new Date(Date.now() + waitTime).toLocaleTimeString()
      });

      if (RATE_LIMITS.startupRetries < RATE_LIMITS.maxStartupRetries) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return verifyCredentialsWithRetry();
      }
    }
    return false;
  }
}

// Update the server startup
app.listen(port, async () => {
  console.log(`Server running at http://localhost:${port}`);
  
  try {
    // Try to verify credentials with retries
    const verified = await verifyCredentialsWithRetry();
    
    if (verified) {
      // Wait a bit before starting mentions check to avoid rate limits
      setTimeout(() => {
        log('info', 'Starting mentions check loop');
        checkMentions();
      }, 30000); // 30 second delay
    } else {
      log('error', 'Failed to verify Twitter credentials after retries');
    }
  } catch (error) {
    log('error', 'Fatal startup error', {
      error: error.message,
      stack: error.stack
    });
  }
});

async function checkMentions() {
  try {
    log('info', 'Starting mentions check...');

    // Match their fetch notifications approach
    const mentions = await userClient.v2.search('@whoptestbot a Whop for my', {
      max_results: 3,
      'tweet.fields': ['referenced_tweets', 'author_id', 'text', 'created_at'],
      expansions: ['referenced_tweets.id', 'author_id']
    });

    if (!mentions?.data?.length) {
      log('info', 'No mentions found');
      return;
    }

    log('info', `Found ${mentions.data.length} mentions`);

    for (const tweet of mentions.data) {
      try {
        if (processedTweets.has(tweet.id)) {
          continue;
        }

        // Match their regex pattern
        const match = tweet.text.match(/@whoptestbot a Whop for my (.+)/i);
        if (match) {
          const businessName = match[1];
          log('process', 'Processing tweet', {
            id: tweet.id,
            text: tweet.text,
            businessName
          });

          const result = await handleWhopGeneration(tweet, false, userClient, log);
          if (result?.status === 'success') {
            processedTweets.add(tweet.id);
          }
        }

      } catch (error) {
        log('error', 'Error processing tweet', {
          error: error.message,
          id: tweet.id
        });
      }
    }

  } catch (error) {
    if (error.code === 429) {
      handleRateLimit(error);
      return;
    }
    log('error', 'Failed to check mentions', {
      error: error.message,
      code: error.code,
      rateLimitInfo: error.rateLimit
    });
  } finally {
    const nextCheck = RATE_LIMITS.resetTime 
      ? Math.max(RATE_LIMITS.currentInterval, RATE_LIMITS.resetTime - Date.now())
      : RATE_LIMITS.currentInterval;
      
    log('info', `Scheduling next check in ${Math.round(nextCheck/1000)}s`);
    setTimeout(checkMentions, nextCheck);
  }
}

// Update rate limit handler
function handleRateLimit(error) {
  // Get reset time from headers if available
  const resetTime = error.rateLimit?.reset 
    ? error.rateLimit.reset * 1000
    : Date.now() + Math.max(RATE_LIMITS.currentInterval * 2, 300000); // At least 5 minutes

  RATE_LIMITS.resetTime = resetTime;
  RATE_LIMITS.currentInterval = Math.min(
    RATE_LIMITS.currentInterval * 2,
    RATE_LIMITS.maxInterval
  );

  log('rate-limit', 'Rate limited', {
    resetsAt: new Date(resetTime).toLocaleTimeString(),
    newInterval: Math.round(RATE_LIMITS.currentInterval / 1000) + 's',
    rateLimitInfo: error.rateLimit || 'No rate limit info'
  });
}

// Add status endpoint
app.get('/status', (req, res) => {
  res.json({
    uptime: process.uptime(),
    processedTweets: processedTweets.size,
    nextCheck: RATE_LIMITS.resetTime 
      ? new Date(RATE_LIMITS.resetTime).toISOString()
      : new Date(Date.now() + RATE_LIMITS.currentInterval).toISOString(),
    currentInterval: Math.round(RATE_LIMITS.currentInterval / 1000) + 's'
  });
}); 