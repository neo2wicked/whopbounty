// Because every bot needs a home, even if it's a dumpster fire
require('dotenv').config();
const express = require('express');
const { TwitterApi } = require('twitter-api-v2');
const { handleWhopGeneration } = require('./index');
const app = express();
const port = process.env.PORT || 3000;

// User context client for everything
const userClient = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

// Basic endpoint to show the bot is alive
app.get('/', (req, res) => {
  res.send('Bot is running! 🤖');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Keep track of processed tweets and rate limits
const processedTweets = new Set();
let nextCheckTime = Date.now();

async function checkMentions() {
  try {
    // Check if we need to wait for rate limit
    if (Date.now() < nextCheckTime) {
      console.log(`Waiting for rate limit, next check at: ${new Date(nextCheckTime).toLocaleTimeString()}`);
      setTimeout(checkMentions, nextCheckTime - Date.now());
      return;
    }

    console.log('Checking for new mentions...');
    
    // Get mentions timeline using the correct method
    const mentions = await userClient.v2.userMentionTimeline(process.env.TWITTER_USER_ID, {
      max_results: 5, // Reduced to avoid rate limits
      'tweet.fields': ['referenced_tweets', 'author_id', 'text']
    });

    // Update rate limit timing
    if (mentions.rateLimit) {
      const resetTime = mentions.rateLimit.reset * 1000; // Convert to milliseconds
      nextCheckTime = resetTime;
      console.log(`Rate limit: ${mentions.rateLimit.remaining}/${mentions.rateLimit.limit}, resets at ${new Date(resetTime).toLocaleTimeString()}`);
    }

    // Check if we have any mentions
    if (!mentions.data) {
      console.log('No new mentions found');
    } else {
      // Log what we found
      console.log(`Found ${mentions.data.length} mentions to process`);

      // Process each mention
      for (const tweet of mentions.data) {
        try {
          // Skip if already processed
          if (processedTweets.has(tweet.id)) {
            console.log(`Skipping already processed tweet: ${tweet.id}`);
            continue;
          }
          
          // Skip retweets
          if (tweet.referenced_tweets?.some(ref => ref.type === 'retweeted')) {
            console.log(`Skipping retweet: ${tweet.id}`);
            continue;
          }

          console.log('Processing new mention:', {
            id: tweet.id,
            text: tweet.text,
            author: tweet.author_id
          });
          
          await handleWhopGeneration(tweet, false, userClient);
          processedTweets.add(tweet.id);
          console.log(`Successfully processed tweet: ${tweet.id}`);
        } catch (error) {
          console.error(`Error processing tweet ${tweet.id}:`, error);
        }
      }
    }
  } catch (error) {
    if (error.code === 429) { // Rate limit error
      const resetTime = error.rateLimit?.reset * 1000 || Date.now() + 60000;
      nextCheckTime = resetTime;
      console.log(`Rate limited, waiting until: ${new Date(resetTime).toLocaleTimeString()}`);
    } else {
      console.error('Failed to check mentions:', error);
    }
  } finally {
    // Schedule next check based on rate limits
    const waitTime = Math.max(60000, nextCheckTime - Date.now()); // At least 1 minute
    console.log(`Next check in ${Math.round(waitTime/1000)} seconds`);
    setTimeout(checkMentions, waitTime);
  }
}

// Start both the server and the bot
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  checkMentions().catch(console.error);
}); 