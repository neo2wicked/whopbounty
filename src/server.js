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
}, {
  retry: true, // Enable retries
  retryLimit: 3, // Retry 3 times
  handlerTimeout: 30000, // 30 second timeout
  requestTimeout: 30000 // 30 second timeout
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

// Update rate limit constants
const RATE_LIMITS = {
  minInterval: 15000,    // Check every 15 seconds (was 60000)
  maxInterval: 300000,   // Max 5 minutes when rate limited (was 15 minutes)
  currentInterval: 15000, // Start with 15 seconds
  backoffFactor: 2       // Double the interval when rate limited (was 1.5)
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

// Add error handling middleware
app.use((err, req, res, next) => {
  log('error', 'Express error handler', {
    error: err.message,
    stack: err.stack
  });
  res.status(500).json({ error: err.message });
});

async function checkMentions() {
  try {
    log('info', 'Starting mentions check...');

    const mentions = await userClient.v2.search('"@GenerateWhop"', {
      max_results: 25,
      'tweet.fields': ['referenced_tweets', 'author_id', 'text', 'created_at', 'conversation_id'],
      expansions: ['referenced_tweets.id', 'author_id', 'in_reply_to_user_id']
    });

    // Debug log the raw response
    log('debug', 'Raw Twitter response', {
      hasData: !!mentions?.data,
      dataLength: mentions?.data?.length,
      firstTweet: mentions?.data?.[0],
      meta: mentions?.meta
    });

    if (!mentions?.data?.length) {
      log('info', 'No mentions found');
      return;
    }

    // Process each mention with better error handling
    for (const tweet of mentions.data) {
      try {
        // Validate tweet object
        if (!tweet?.id || !tweet?.text) {
          log('error', 'Invalid tweet object', { tweet });
          continue;
        }

        // Skip if already processed
        if (processedTweets.has(tweet.id)) {
          log('skip', `Already processed tweet ${tweet.id}`);
          continue;
        }

        // Skip retweets and replies to other tweets
        if (tweet.referenced_tweets?.some(ref => ref.type === 'retweeted')) {
          log('skip', `Skipping retweet ${tweet.id}`);
          continue;
        }

        log('process', 'Processing tweet', {
          id: tweet.id,
          text: tweet.text,
          author: tweet.author_id,
          created_at: tweet.created_at
        });

        // Process the tweet
        const result = await handleWhopGeneration(
          {
            id: tweet.id,
            text: tweet.text,
            author_id: tweet.author_id,
            created_at: tweet.created_at
          },
          false,
          userClient,
          log
        );

        // Mark as processed if successful
        if (result?.status === 'success') {
          processedTweets.add(tweet.id);
          log('success', `Successfully processed tweet ${tweet.id}`, {
            store: result.store
          });
        }

      } catch (error) {
        log('error', `Error processing tweet ${tweet?.id}`, {
          error: error.message,
          stack: error.stack,
          tweet: {
            id: tweet?.id,
            text: tweet?.text
          }
        });
        // Continue processing other tweets even if one fails
        continue;
      }
    }

  } catch (error) {
    log('error', 'Failed to check mentions', {
      error: error.message,
      stack: error.stack
    });
  } finally {
    // Schedule next check
    const waitTime = Math.max(RATE_LIMITS.currentInterval, nextCheckTime - Date.now());
    log('info', `Scheduling next check in ${Math.round(waitTime/1000)}s`);
    setTimeout(checkMentions, waitTime);
  }
}

// Verify credentials on startup
async function verifyTwitterCredentials() {
  try {
    const me = await userClient.v2.me();
    log('info', 'Twitter credentials verified', {
      id: me.data.id,
      username: me.data.username,
      name: me.data.name
    });
    return true;
  } catch (error) {
    log('error', 'Failed to verify Twitter credentials', {
      error: error.message,
      stack: error.stack
    });
    return false;
  }
}

// Add test endpoint
app.get('/test/mentions', async (req, res) => {
  try {
    log('info', 'Manual mentions check triggered');
    await checkMentions();
    res.json({ status: 'ok', logs: recentLogs });
  } catch (error) {
    log('error', 'Manual check failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Update the server startup
app.listen(port, async () => {
  console.log(`Server running at http://localhost:${port}`);
  try {
    await verifyTwitterCredentials();
    await checkMentions();
  } catch (error) {
    console.error('Failed to start bot:', error);
  }
}); 