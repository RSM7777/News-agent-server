// server.js - Complete AI News Agent Backend with MongoDB
const express = require('express');
require('dotenv').config();
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const xml2js = require('xml2js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Configuration
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY; // Get from Google AI Studio
const MONGODB_URI = process.env.MONGODB_URI; // Local MongoDB or use MongoDB Atlas

const genAI = new GoogleGenerativeAI(GOOGLE_AI_API_KEY);

// MongoDB Connection
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch((err) => console.error('❌ MongoDB connection error:', err));

// MongoDB Schemas
const userPreferenceSchema = new mongoose.Schema({
  sessionId: String,
  userName: String,
  interests: [String],
  blocked: [String],
  preferredSources: [String],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const articleFeedbackSchema = new mongoose.Schema({
  sessionId: String,
  articleId: String,
  articleTitle: String,
  action: { type: String, enum: ['like', 'dislike', 'save'] },
  query: String,
  timestamp: { type: Date, default: Date.now }
});

const UserPreference = mongoose.model('UserPreference', userPreferenceSchema);
const ArticleFeedback = mongoose.model('ArticleFeedback', articleFeedbackSchema);

// Helper function to get or create user session
const getUserSession = async (sessionId) => {
  let userPrefs = await UserPreference.findOne({ sessionId });
  
  if (!userPrefs) {
    userPrefs = new UserPreference({
      sessionId,
      interests: ['technology', 'business', 'science'],
      blocked: [],
      preferredSources: []
    });
    await userPrefs.save();
    console.log(`✅ Created new user session: ${sessionId}`);
  }
  
  return userPrefs;
};

// Helper function to get user feedback for filtering
const getUserFeedback = async (sessionId) => {
  const feedback = await ArticleFeedback.find({ sessionId });
  
  return {
    likedArticles: feedback.filter(f => f.action === 'like').map(f => f.articleId),
    dislikedArticles: feedback.filter(f => f.action === 'dislike').map(f => f.articleId),
    savedArticles: feedback.filter(f => f.action === 'save').map(f => f.articleId)
  };
};

// Helper function to create realistic headers
const createHeaders = () => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cache-Control': 'max-age=0'
});

// Function to parse date requirements from query
const parseDateFromQuery = (query) => {
  const lowerQuery = query.toLowerCase();
  const now = new Date();
  
  // Today's news - but be more flexible for better results
  if (lowerQuery.includes('today') || lowerQuery.includes('latest') || lowerQuery.includes('recent')) {
    const threeDaysAgo = new Date(now); // Changed: be more flexible with "today"
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    return {
      timeframe: 'today',
      fromDate: threeDaysAgo, // Allow last 3 days for "today" queries
      toDate: now,
      googleParam: '3d' // Changed from 1d to 3d
    };
  }
  
  // Yesterday's news
  if (lowerQuery.includes('yesterday')) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const startOfYesterday = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
    const endOfYesterday = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59);
    return {
      timeframe: 'yesterday',
      fromDate: startOfYesterday,
      toDate: endOfYesterday,
      googleParam: '3d' // Changed: get more context
    };
  }
  
  // This week
  if (lowerQuery.includes('this week') || lowerQuery.includes('week')) {
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    return {
      timeframe: 'week',
      fromDate: weekAgo,
      toDate: now,
      googleParam: '7d'
    };
  }
  
  // Specific date patterns (e.g., "news from August 20", "news from 20th August")
  const dateMatches = lowerQuery.match(/(?:from|on|about)\s+(?:august|aug)\s+(\d{1,2})|(\d{1,2})(?:st|nd|rd|th)?\s+(?:august|aug)/i);
  if (dateMatches) {
    const day = parseInt(dateMatches[1] || dateMatches[2]);
    const specificDate = new Date(now.getFullYear(), 7, day); // August is month 7 (0-based)
    const endOfDay = new Date(specificDate);
    endOfDay.setHours(23, 59, 59);
    return {
      timeframe: 'specific',
      fromDate: specificDate,
      toDate: endOfDay,
      googleParam: '1m'
    };
  }
  
  // Default: last 7 days for any news query (increased from 3 days)
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  return {
    timeframe: 'default',
    fromDate: weekAgo,
    toDate: now,
    googleParam: '7d' // Changed from 3d to 7d for more results
  };
};

// Function to fetch from multiple news sources
const fetchMultipleSources = async (query, dateFilter, retries = 2) => {
  const encodedQuery = encodeURIComponent(query);
  const allArticles = [];
  
  // Source 1: Google News (primary - supports query filtering)
  try {
    const googleArticles = await fetchGoogleNews(encodedQuery, dateFilter.googleParam, retries);
    allArticles.push(...googleArticles);
    console.log(`Google News: ${googleArticles.length} articles`);
  } catch (error) {
    console.log('Google News failed:', error.message);
  }
  
  // Source 2: BBC News RSS (only if Google fails and query matches general topics)
  if (allArticles.length < 5 && isGeneralTopic(query)) {
    try {
      const bbcArticles = await fetchBBCNews(query, retries);
      allArticles.push(...bbcArticles);
      console.log(`BBC News: ${bbcArticles.length} articles`);
    } catch (error) {
      console.log('BBC News failed:', error.message);
    }
  }
  
  // Source 3: Reuters RSS (only if Google fails and query matches general topics)
  if (allArticles.length < 5 && isGeneralTopic(query)) {
    try {
      const reutersArticles = await fetchReutersNews(query, retries);
      allArticles.push(...reutersArticles);
      console.log(`Reuters: ${reutersArticles.length} articles`);
    } catch (error) {
      console.log('Reuters failed:', error.message);
    }
  }
  
  return allArticles;
};

// Check if query matches general topics that BBC/Reuters might have
const isGeneralTopic = (query) => {
  const generalTopics = [
    'technology', 'tech', 'business', 'politics', 'world', 'news', 
    'economy', 'health', 'science', 'sports', 'entertainment'
  ];
  
  const lowerQuery = query.toLowerCase();
  return generalTopics.some(topic => lowerQuery.includes(topic));
};

// Function to fetch Google News RSS with better error handling
const fetchGoogleNews = async (query, timeParam = '7d', retries = 3) => {
  const encodedQuery = encodeURIComponent(query);
  
  // Multiple URL formats with time parameters - prioritize most reliable
  const urls = [
    `https://news.google.com/rss/search?q=${encodedQuery}&when=${timeParam}&hl=en&gl=US`,
    `https://news.google.com/rss/search?q=${encodedQuery}&hl=en&gl=US`, // Without time filter to get more results
    `https://news.google.com/rss/search?q=${encodedQuery}&when=7d&hl=en&gl=US`, // Force 7 days
    `https://news.google.com/rss/search?q=${encodedQuery}&when=1m&hl=en&gl=US`, // Try 1 month
    `https://news.google.com/news/rss/search/section/q/${encodedQuery}?hl=en&gl=US`,
  ];

  for (let i = 0; i < urls.length; i++) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        console.log(`🔍 Google News - URL ${i + 1}, try ${attempt + 1}`);
        console.log(`🌐 Trying: ${urls[i]}`);
        
        const response = await axios.get(urls[i], {
          headers: createHeaders(),
          timeout: 15000,
          validateStatus: (status) => status < 400
        });

        if (response.data && response.data.includes('<item>')) {
          console.log('✅ Google News RSS data received successfully');
          const articles = await parseRSSFeed(response.data);
          console.log(`✅ Raw articles parsed: ${articles.length}`);
          
          // Log article titles for debugging
          if (articles.length > 0) {
            console.log('📰 Found articles:');
            articles.slice(0, 5).forEach((article, index) => {
              console.log(`  ${index + 1}. ${article.title}`);
            });
            
            return articles.map(article => ({ ...article, source: 'Google News' }));
          } else {
            console.log('⚠️ RSS parsed but no articles found');
          }
        } else {
          console.log('❌ No valid RSS items found in response');
          console.log(`📄 Response preview: ${response.data.substring(0, 200)}...`);
        }
      } catch (error) {
        console.log(`❌ Google attempt ${attempt + 1} failed:`, error.message);
        
        if (attempt < retries - 1) {
          console.log(`⏳ Waiting ${(attempt + 1) * 2} seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 2000));
        }
      }
    }
  }
  
  console.log('❌ All Google News attempts failed');
  return []; // Return empty array instead of throwing error
};

// Backup sources function (only for general topics when Google fails)
const fetchBackupSources = async (query, dateFilter) => {
  const allArticles = [];
  
  try {
    const bbcArticles = await fetchBBCNews(query, 1);
    allArticles.push(...bbcArticles);
    console.log(`Backup BBC News: ${bbcArticles.length} articles`);
  } catch (error) {
    console.log('BBC backup failed:', error.message);
  }
  
  return allArticles;
};

// Simplified BBC News function for backup only
const fetchBBCNews = async (query, retries = 1) => {
  const lowerQuery = query.toLowerCase();
  let feedUrl = 'https://feeds.bbci.co.uk/news/rss.xml'; // Default to general news
  
  // Map to specific BBC categories if applicable
  if (lowerQuery.includes('tech') || lowerQuery.includes('technology')) {
    feedUrl = 'https://feeds.bbci.co.uk/news/technology/rss.xml';
  } else if (lowerQuery.includes('business')) {
    feedUrl = 'https://feeds.bbci.co.uk/news/business/rss.xml';
  } else if (lowerQuery.includes('health')) {
    feedUrl = 'https://feeds.bbci.co.uk/news/health/rss.xml';
  }
  
  try {
    console.log(`Trying BBC feed: ${feedUrl}`);
    const response = await axios.get(feedUrl, {
      headers: createHeaders(),
      timeout: 8000
    });
    
    if (response.data && response.data.includes('<item>')) {
      const articles = await parseRSSFeed(response.data);
      console.log(`BBC RSS parsed: ${articles.length} articles`);
      
      // Manual filtering since BBC doesn't support query parameters
      const relevantArticles = articles.filter(article => {
        const searchText = `${article.title} ${article.description}`.toLowerCase();
        const queryWords = query.toLowerCase().split(' ').filter(word => word.length > 2);
        return queryWords.some(word => searchText.includes(word));
      }).slice(0, 5); // Limit BBC articles
      
      console.log(`BBC relevant articles: ${relevantArticles.length}`);
      return relevantArticles.map(article => ({ 
        ...article, 
        source: 'BBC News' 
      }));
    }
  } catch (error) {
    console.log(`BBC News failed: ${error.message}`);
  }
  
  return [];
};

// Function to fetch Reuters News (only for general topics)
const fetchReutersNews = async (query, retries = 2) => {
  // Map query to appropriate Reuters RSS feeds
  const lowerQuery = query.toLowerCase();
  let feedUrls = [];
  
  if (lowerQuery.includes('tech')) {
    feedUrls.push('https://www.reuters.com/rssFeed/technologyNews');
  }
  if (lowerQuery.includes('business') || lowerQuery.includes('economy')) {
    feedUrls.push('https://www.reuters.com/rssFeed/businessNews');
  }
  if (lowerQuery.includes('world') || lowerQuery.includes('politics')) {
    feedUrls.push('https://www.reuters.com/rssFeed/worldNews');
  }
  
  // If no specific category, use world news
  if (feedUrls.length === 0) {
    feedUrls.push('https://www.reuters.com/rssFeed/worldNews');
  }
  
  const allArticles = [];
  
  for (const url of feedUrls) {
    try {
      const response = await axios.get(url, {
        headers: createHeaders(),
        timeout: 8000
      });
      
      if (response.data && response.data.includes('<item>')) {
        const articles = await parseRSSFeed(response.data);
        // Since Reuters doesn't support query filtering, we filter manually
        const relevantArticles = articles.filter(article => {
          const searchText = `${article.title} ${article.description}`.toLowerCase();
          const queryWords = query.toLowerCase().split(' ');
          return queryWords.some(word => 
            word.length > 2 && searchText.includes(word)
          );
        }).slice(0, 3); // Limit Reuters articles
        
        allArticles.push(...relevantArticles.map(article => ({ 
          ...article, 
          source: 'Reuters' 
        })));
      }
    } catch (error) {
      console.log(`Reuters failed for ${url}:`, error.message);
    }
  }
  
  return allArticles;
};

// Function to parse RSS XML
const parseRSSFeed = async (xmlData) => {
  try {
    const parser = new xml2js.Parser({ explicitArray: false });
    const result = await parser.parseStringPromise(xmlData);
    
    if (!result.rss || !result.rss.channel || !result.rss.channel.item) {
      throw new Error('Invalid RSS format');
    }

    const items = Array.isArray(result.rss.channel.item) 
      ? result.rss.channel.item 
      : [result.rss.channel.item];

    return items.map((item, index) => ({
      id: `article_${Date.now()}_${index}`,
      title: item.title || 'No title',
      description: item.description ? 
        item.description.replace(/<[^>]*>/g, '').substring(0, 200) + '...' : 
        'No description available',
      link: item.link || '',
      pubDate: item.pubDate || new Date().toISOString(),
      source: extractSource(item.link || item.source)
    }));
  } catch (error) {
    console.error('RSS parsing error:', error.message);
    throw new Error('Failed to parse RSS feed');
  }
};

// Extract source name from URL
const extractSource = (url) => {
  if (!url) return 'Unknown';
  try {
    const domain = new URL(url).hostname;
    return domain.replace('www.', '').split('.')[0];
  } catch {
    return 'Unknown';
  }
};

// Function to get AI analysis of news
const getAIAnalysis = async (articles, query, userPrefs) => {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); // Updated to latest model
    
    const articlesText = articles.map(article => 
      `Title: ${article.title}\nDescription: ${article.description}\nSource: ${article.source}`
    ).join('\n\n');

    const prompt = `
    As an AI news assistant, analyze these news articles for the user query: "${query}"
    
    User Preferences:
    - Interests: ${userPrefs?.interests?.join(', ') || 'General'}
    - Blocked Topics: ${userPrefs?.blocked?.join(', ') || 'None'}
    
    News Articles:
    ${articlesText}
    
    Provide a brief, personalized summary focusing on:
    1. Key trends and insights
    2. Most important developments
    3. Relevance to user's interests
    
    Keep response concise (max 150 words) and engaging.
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error('AI analysis error:', error.message);
    
    // Fallback response if AI fails
    const topicFromQuery = query.toLowerCase().includes('elon musk') ? 'Elon Musk' : 
                          query.toLowerCase().includes('tesla') ? 'Tesla' :
                          query.toLowerCase().includes('tech') ? 'technology' : 'this topic';
    
    return `Here are the latest news articles about ${topicFromQuery}. I found ${articles.length} relevant articles covering recent developments. The articles include updates from major news sources and cover the most important recent events and announcements.`;
  }
};

// Filter articles by date range
const filterArticlesByDate = (articles, dateFilter) => {
  return articles.filter(article => {
    if (!article.pubDate) return true; // Keep articles without date
    
    const articleDate = new Date(article.pubDate);
    if (isNaN(articleDate.getTime())) return true; // Keep articles with invalid date
    
    // Check if article is within the specified date range
    return articleDate >= dateFilter.fromDate && articleDate <= dateFilter.toDate;
  });
};

// Sort articles by date (newest first)
const sortArticlesByDate = (articles) => {
  return articles.sort((a, b) => {
    const dateA = new Date(a.pubDate || 0);
    const dateB = new Date(b.pubDate || 0);
    return dateB - dateA; // Newest first
  });
};

// Filter articles based on user preferences and feedback
const filterArticlesByPreferences = async (articles, sessionId) => {
  try {
    // Get user preferences and feedback from database
    const userPrefs = await getUserSession(sessionId);
    const feedback = await getUserFeedback(sessionId);
    
    return articles.filter(article => {
      const articleText = `${article.title} ${article.description}`.toLowerCase();
      
      // Check blocked topics
      if (userPrefs.blocked && userPrefs.blocked.length > 0) {
        const hasBlockedTopic = userPrefs.blocked.some(blocked => 
          articleText.includes(blocked.toLowerCase())
        );
        if (hasBlockedTopic) return false;
      }
      
      // Check disliked articles
      if (feedback.dislikedArticles.includes(article.id)) {
        return false;
      }
      
      return true;
    });
  } catch (error) {
    console.error('Error filtering articles by preferences:', error);
    return articles; // Return all articles if filtering fails
  }
};

// Main news endpoint
app.post('/webhook/news-agent', async (req, res) => {
  try {
    const { query, userPreferences } = req.body;
    
    if (!query) {
      return res.status(400).json({ 
        error: 'Query parameter is required' 
      });
    }

    console.log('Processing news request for query:', query);
    
    // Get or create session ID
    const sessionId = req.ip || req.headers['x-forwarded-for'] || 'default';
    
    // Parse date requirements from query
    const dateFilter = parseDateFromQuery(query);
    console.log(`Date filter: ${dateFilter.timeframe} (${dateFilter.fromDate.toDateString()} to ${dateFilter.toDate.toDateString()})`);
    
    // Store/update user preferences in database
    if (userPreferences) {
      try {
        await UserPreference.findOneAndUpdate(
          { sessionId },
          {
            ...userPreferences,
            sessionId,
            updatedAt: new Date()
          },
          { upsert: true, new: true }
        );
        console.log('✅ User preferences updated in database');
      } catch (error) {
        console.error('Error updating user preferences:', error);
      }
    }

    // Fetch news primarily from Google News
    let allArticles = [];
    try {
      // Focus on Google News first (supports proper query filtering)
      const googleArticles = await fetchGoogleNews(query, dateFilter.googleParam);
      allArticles.push(...googleArticles);
      console.log(`Google News: ${googleArticles.length} articles found`);
      
      // Only use other sources if Google News fails completely AND it's a general topic
      if (googleArticles.length === 0 && isGeneralTopic(query)) {
        console.log('Google News failed, trying backup sources...');
        const backupArticles = await fetchBackupSources(query, dateFilter);
        allArticles.push(...backupArticles);
      }
      
    } catch (error) {
      console.error('Failed to fetch from news sources:', error.message);
      
      return res.json({
        articles: [],
        aiResponse: `I'm sorry, I couldn't fetch the latest news for "${query}" right now due to technical issues. Please try again in a few moments.`,
        error: 'News sources temporarily unavailable'
      });
    }

    if (allArticles.length === 0) {
      return res.json({
        articles: [],
        aiResponse: `No articles found for "${query}" in the specified time period (${dateFilter.timeframe}). Try a different search term or time range.`,
        totalFound: 0
      });
    }

    console.log(`📊 Initial articles fetched: ${allArticles.length}`);

    // Filter articles by date range
    const dateFilteredArticles = filterArticlesByDate(allArticles, dateFilter);
    console.log(`📊 Articles after date filtering: ${dateFilteredArticles.length}`);

    // Remove duplicates
    const uniqueArticles = removeDuplicateArticles(dateFilteredArticles);
    console.log(`📊 Articles after removing duplicates: ${uniqueArticles.length}`);

    // Sort by date (newest first)
    const sortedArticles = sortArticlesByDate(uniqueArticles);

    // Filter articles based on user preferences and feedback from database
    const filteredArticles = await filterArticlesByPreferences(sortedArticles, sessionId);
    console.log(`📊 Articles after preference filtering: ${filteredArticles.length}`);

    // If we have very few articles, try to get more with broader search
    if (filteredArticles.length <= 3 && !query.toLowerCase().includes('today') && !query.toLowerCase().includes('yesterday')) {
      console.log(`⚠️ Only ${filteredArticles.length} articles found, trying broader search...`);
      
      try {
        // Try without time restrictions to get more results
        const broaderArticles = await fetchGoogleNews(query, '7d'); // 7 days instead
        if (broaderArticles.length > filteredArticles.length) {
          console.log(`✅ Broader search found ${broaderArticles.length} articles`);
          const broaderFiltered = await filterArticlesByPreferences(
            sortArticlesByDate(removeDuplicateArticles(broaderArticles)), 
            sessionId
          );
          if (broaderFiltered.length > filteredArticles.length) {
            filteredArticles.length = 0; // Clear original array
            filteredArticles.push(...broaderFiltered.slice(0, 15));
            console.log(`📊 Final count after broader search: ${filteredArticles.length}`);
          }
        }
      } catch (error) {
        console.log('Broader search failed:', error.message);
      }
    }

    // Get user preferences for AI analysis
    const userPrefs = await getUserSession(sessionId);

    // Get AI analysis
    const aiAnalysis = await getAIAnalysis(filteredArticles.slice(0, 5), query, userPrefs);

    // Prepare response with date context
    const response = {
      articles: filteredArticles.slice(0, 15), // Increased from 10 to 15 articles
      aiResponse: aiAnalysis,
      totalFound: filteredArticles.length,
      query: query,
      sessionId: sessionId, // Include session ID for frontend
      timeframe: dateFilter.timeframe,
      dateRange: {
        from: dateFilter.fromDate.toISOString(),
        to: dateFilter.toDate.toISOString()
      },
      timestamp: new Date().toISOString()
    };

    console.log(`Successfully processed request: ${filteredArticles.length} articles found for ${dateFilter.timeframe}`);
    res.json(response);

  } catch (error) {
    console.error('Error processing news request:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

// User feedback endpoint for learning (UPDATED)
app.post('/api/feedback', async (req, res) => {
  try {
    const { articleId, articleTitle, action, query, sessionId } = req.body;
    
    if (!articleId || !action || !sessionId) {
      return res.status(400).json({ 
        error: 'articleId, action, and sessionId are required' 
      });
    }

    console.log(`📝 Received feedback: ${action} for article ${articleId} from session ${sessionId}`);
    
    // Save feedback to database
    const feedback = new ArticleFeedback({
      sessionId,
      articleId,
      articleTitle,
      action, // 'like', 'dislike', or 'save'
      query,
      timestamp: new Date()
    });
    
    await feedback.save();
    console.log('✅ Feedback saved to database');
    
    // Update user preferences based on feedback
    if (action === 'dislike') {
      // Extract potential topics to block from article title
      const articleText = articleTitle?.toLowerCase() || '';
      const userPrefs = await getUserSession(sessionId);
      
      // Smart topic detection for blocking suggestions
      let suggestedBlock = null;
      if (articleText.includes('crypto') || articleText.includes('bitcoin')) {
        suggestedBlock = 'cryptocurrency';
      } else if (articleText.includes('politics') || articleText.includes('election')) {
        suggestedBlock = 'politics';
      } else if (articleText.includes('sports') || articleText.includes('football')) {
        suggestedBlock = 'sports';
      }
      
      res.json({ 
        success: true, 
        message: 'Feedback recorded successfully',
        suggestion: suggestedBlock ? {
          type: 'block_topic',
          topic: suggestedBlock,
          message: `Would you like to block all ${suggestedBlock} news?`
        } : null
      });
    } else {
      res.json({ 
        success: true, 
        message: 'Feedback recorded successfully'
      });
    }
    
  } catch (error) {
    console.error('Error saving feedback:', error);
    res.status(500).json({ 
      error: 'Failed to save feedback',
      message: error.message 
    });
  }
});

// New endpoint to block/unblock topics
app.post('/api/preferences/block-topic', async (req, res) => {
  try {
    const { sessionId, topic, action } = req.body; // action: 'block' or 'unblock'
    
    if (!sessionId || !topic || !action) {
      return res.status(400).json({ 
        error: 'sessionId, topic, and action are required' 
      });
    }

    const userPrefs = await getUserSession(sessionId);
    
    if (action === 'block') {
      if (!userPrefs.blocked.includes(topic)) {
        userPrefs.blocked.push(topic);
        await userPrefs.save();
        console.log(`✅ Blocked topic '${topic}' for session ${sessionId}`);
      }
    } else if (action === 'unblock') {
      userPrefs.blocked = userPrefs.blocked.filter(t => t !== topic);
      await userPrefs.save();
      console.log(`✅ Unblocked topic '${topic}' for session ${sessionId}`);
    }
    
    res.json({ 
      success: true, 
      message: `Topic ${action}ed successfully`,
      blockedTopics: userPrefs.blocked 
    });
    
  } catch (error) {
    console.error('Error updating blocked topics:', error);
    res.status(500).json({ 
      error: 'Failed to update preferences',
      message: error.message 
    });
  }
});

// Get user preferences endpoint
app.get('/api/preferences/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userPrefs = await getUserSession(sessionId);
    const feedback = await getUserFeedback(sessionId);
    
    res.json({
      preferences: {
        interests: userPrefs.interests,
        blocked: userPrefs.blocked,
        preferredSources: userPrefs.preferredSources,
        userName: userPrefs.userName
      },
      feedback: {
        likedCount: feedback.likedArticles.length,
        dislikedCount: feedback.dislikedArticles.length,
        savedCount: feedback.savedArticles.length
      }
    });
    
  } catch (error) {
    console.error('Error fetching preferences:', error);
    res.status(500).json({ 
      error: 'Failed to fetch preferences',
      message: error.message 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'AI News Agent',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Remove duplicate articles
const removeDuplicateArticles = (articles) => {
  const seen = new Set();
  return articles.filter(article => {
    const key = article.title.toLowerCase().replace(/[^\w]/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// Start server
app.listen(PORT, () => {
  console.log(`🚀 AI News Agent server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`News endpoint: http://localhost:${PORT}/webhook/news-agent`);
});

module.exports = app;