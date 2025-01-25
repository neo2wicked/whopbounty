// Look at you, trying to be all fancy with your Twitter bot
require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const OpenAI = require('openai');
const axios = require('axios');

// Initialize with both OAuth 1.0a and OAuth 2.0
const twitterClient = new TwitterApi({
  // OAuth 1.0a credentials for streaming
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
  // OAuth 2.0 credentials
  clientId: process.env.TWITTER_CLIENT_ID,
  clientSecret: process.env.TWITTER_CLIENT_SECRET
});

// New OpenAI client because you can't be bothered to read the docs
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Oh lord, here we go - the main bot logic that'll probably break
async function handleWhopGeneration(tweet, testMode = false, twitterClient = null, log) {
  const prompt = tweet.text.replace('@GenerateWhop', '').trim();
  
  try {
    log('process', 'Generating store details with GPT-4...', { tweet: tweet.text });
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{
        role: "system",
        content: "Generate a JSON object for a Whop store with these fields: name (string), description (string), boldClaim (string). Make it relevant to the prompt."
      }, {
        role: "user",
        content: prompt
      }]
    });

    const storeDetails = JSON.parse(completion.choices[0].message.content);
    log('info', 'Generated store details', { storeDetails });
    
    log('process', 'Generating logo with DALL-E...');
    const logoResponse = await openai.images.generate({
      prompt: `Professional minimalist logo for ${storeDetails.name}, business icon`,
      n: 1,
      size: '1024x1024'
    });
    log('info', 'Generated logo', { url: logoResponse.data[0].url });

    log('process', 'Creating Whop store...');
    const whopResponse = await axios.post('https://whop.com/api/onboarding/create-company', {
      name: storeDetails.name,
      description: storeDetails.description,
      bold_claim: storeDetails.boldClaim,
      logo_url: logoResponse.data[0].url,
      type: "community",
      visibility: "public",
      _rsc: "1",
      _method: "POST"
    }, {
      headers: {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.WHOP_API_KEY}`,
        'Origin': 'https://whop.com',
        'Referer': 'https://whop.com/onboarding',
        'X-Frame-Options': 'SAMEORIGIN',
        'Next-Router-State-Tree': 'true',
        'Next-Router-Prefetch': 'true',
        'RSC': '1',
        'X-Vercel-Cache': 'MISS'
      },
      maxRedirects: 5, // Allow some redirects for live mode
      withCredentials: true,
      validateStatus: function (status) {
        return status >= 200 && status < 400; // Only accept success codes
      }
    });

    const storeUrl = whopResponse.headers?.location || 
                    whopResponse.data?.url || 
                    `https://whop.com/${storeDetails.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    
    log('success', 'Created Whop store', { url: storeUrl });

    if (!testMode && twitterClient) {
      log('process', 'Replying to tweet...');
      await twitterClient.v2.reply(
        `✨ Created your Whop store! Check it out: ${storeUrl}`,
        tweet.id
      );
      log('success', 'Replied to tweet');
    }

    return {
      status: 'success',
      store: {
        name: storeDetails.name,
        url: storeUrl,
        response: whopResponse.data
      },
      tweet: testMode ? null : tweet
    };

  } catch (error) {
    log('error', 'Failed to generate store', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

module.exports = { handleWhopGeneration }; 