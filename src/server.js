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
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

// Create a list to store recent logs
const recentLogs = [];
const MAX_LOGS = 100;
const clients = new Set();

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

// Status endpoint
app.get('/status', (req, res) => {
  res.json({
    uptime: process.uptime(),
    processedTweets: processedTweets.size,
    nextCheck: new Date(nextCheckTime).toISOString(),
    currentInterval: RATE_LIMITS.currentInterval,
    recentLogs: recentLogs.slice(0, 10)
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Keep track of processed tweets and rate limits
const processedTweets = new Set();
let nextCheckTime = Date.now();

// Add rate limit handling
const RATE_LIMITS = {
  minInterval: 60000, // 1 minute minimum
  maxInterval: 900000, // 15 minutes maximum
  currentInterval: 60000,
  backoffFactor: 1.5
};

function adjustPollingInterval(isRateLimited) {
  if (isRateLimited) {
    // Increase interval when rate limited
    RATE_LIMITS.currentInterval = Math.min(
      RATE_LIMITS.currentInterval * RATE_LIMITS.backoffFactor,
      RATE_LIMITS.maxInterval
    );
    log('rate-limit', 'Increasing polling interval', {
      newInterval: Math.round(RATE_LIMITS.currentInterval / 1000) + 's'
    });
  } else {
    // Gradually decrease interval when successful
    RATE_LIMITS.currentInterval = Math.max(
      RATE_LIMITS.currentInterval / RATE_LIMITS.backoffFactor,
      RATE_LIMITS.minInterval
    );
  }
  return RATE_LIMITS.currentInterval;
}

async function checkMentions() {
  try {
    if (Date.now() < nextCheckTime) {
      const waitTime = nextCheckTime - Date.now();
      log('rate-limit', `Waiting for rate limit`, {
        nextCheck: new Date(nextCheckTime).toLocaleTimeString(),
        waitTimeSeconds: Math.round(waitTime / 1000)
      });
      setTimeout(checkMentions, waitTime);
      return;
    }

    log('info', 'Checking for new mentions...');
    
    const mentions = await userClient.v2.userMentionTimeline(process.env.TWITTER_USER_ID, {
      max_results: 5,
      'tweet.fields': ['referenced_tweets', 'author_id', 'text']
    });

    // Handle rate limits
    if (mentions.rateLimit) {
      const resetTime = mentions.rateLimit.reset * 1000;
      if (mentions.rateLimit.remaining < 2) { // Buffer of 1
        nextCheckTime = resetTime;
        adjustPollingInterval(true);
      } else {
        adjustPollingInterval(false);
      }
      
      log('rate-limit', 'Rate limit info', {
        remaining: mentions.rateLimit.remaining,
        limit: mentions.rateLimit.limit,
        resetsAt: new Date(resetTime).toLocaleTimeString(),
        currentInterval: Math.round(RATE_LIMITS.currentInterval / 1000) + 's'
      });
    }

    if (!mentions.data) {
      log('info', 'No new mentions found');
    } else {
      log('info', `Found mentions to process`, {
        count: mentions.data.length,
        tweets: mentions.data.map(t => ({ id: t.id, text: t.text }))
      });

      for (const tweet of mentions.data) {
        try {
          if (processedTweets.has(tweet.id)) {
            log('skip', `Already processed tweet`, { id: tweet.id });
            continue;
          }
          
          if (tweet.referenced_tweets?.some(ref => ref.type === 'retweeted')) {
            log('skip', `Skipping retweet`, { id: tweet.id });
            continue;
          }

          log('process', 'Processing new mention', {
            id: tweet.id,
            text: tweet.text,
            author: tweet.author_id
          });
          
          const result = await handleWhopGeneration(tweet, false, userClient, log);
          processedTweets.add(tweet.id);
          
          log('success', `Successfully processed tweet`, {
            id: tweet.id,
            store: result.store
          });
        } catch (error) {
          log('error', `Error processing tweet`, {
            id: tweet.id,
            error: error.message,
            stack: error.stack
          });
        }
      }
    }
  } catch (error) {
    if (error.code === 429) {
      const resetTime = error.rateLimit?.reset * 1000 || Date.now() + RATE_LIMITS.currentInterval;
      nextCheckTime = resetTime;
      adjustPollingInterval(true);
      
      log('rate-limit', `Rate limited`, {
        resetsAt: new Date(resetTime).toLocaleTimeString(),
        newInterval: Math.round(RATE_LIMITS.currentInterval / 1000) + 's'
      });
    } else {
      log('error', 'Failed to check mentions', {
        error: error.message,
        stack: error.stack
      });
    }
  } finally {
    // Use our dynamic interval
    const waitTime = Math.max(RATE_LIMITS.currentInterval, nextCheckTime - Date.now());
    log('info', `Scheduling next check`, {
      inSeconds: Math.round(waitTime/1000),
      currentInterval: Math.round(RATE_LIMITS.currentInterval/1000) + 's'
    });
    setTimeout(checkMentions, waitTime);
  }
}

// Start both the server and the bot
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  checkMentions().catch(console.error);
}); 