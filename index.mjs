import https from 'https';

export const handler = async (event) => {
  // Structured logging helper
  const log = {
    info: (message, data = {}) => {
      console.log(JSON.stringify({ level: 'INFO', message, ...data, timestamp: new Date().toISOString() }));
    },
    warn: (message, data = {}) => {
      console.warn(JSON.stringify({ level: 'WARN', message, ...data, timestamp: new Date().toISOString() }));
    },
    error: (message, error = {}, data = {}) => {
      console.error(JSON.stringify({
        level: 'ERROR',
        message,
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
          ...error
        },
        ...data,
        timestamp: new Date().toISOString()
      }));
    }
  };

  log.info('Lambda function invoked', { 
    httpMethod: event.httpMethod,
    path: event.path,
    headers: event.headers
  });

  if (event.httpMethod === 'OPTIONS') {
    log.info('CORS preflight request handled');
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
      body: ''
    };
  }

  try {
    let parsedBody;
    try {
      parsedBody = JSON.parse(event.body || '{}');
    } catch (parseError) {
      log.error('Failed to parse request body', parseError, { body: event.body });
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid JSON in request body' }),
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
      };
    }

    const { prompt, markdown, selectedText } = parsedBody;
    
    log.info('Request parsed', {
      hasPrompt: !!prompt,
      markdownLength: markdown?.length || 0,
      hasSelectedText: !!selectedText
    });
    
    if (!prompt || prompt.trim() === '') {
      log.warn('Request validation failed: prompt is required');
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Prompt is required' }),
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
      };
    }

    function estimateTokens(text) {
      return Math.ceil(text.length / 4);
    }

    function truncateContent(content, maxTokens) {
      const estimatedTokens = estimateTokens(content);
      
      if (estimatedTokens <= maxTokens) {
        return content;
      }
      
      log.warn('Content truncation required', {
        originalTokens: estimatedTokens,
        maxTokens: maxTokens,
        truncationPercentage: ((estimatedTokens - maxTokens) / estimatedTokens * 100).toFixed(2)
      });
      
      const charsPerToken = 4;
      const maxChars = maxTokens * charsPerToken;
      const firstPortion = Math.floor(maxChars * 0.6);
      const lastPortion = Math.floor(maxChars * 0.2);
      
      return content.substring(0, firstPortion) + 
             '\n\n[... middle section truncated for length ...]\n\n' + 
             content.substring(content.length - lastPortion);
    }

    // FIXED: Reduced from 270000 to fit within gpt-4o Tier 1 30k TPM limit
    // Reserving ~5k tokens for prompt/system message and output
    const MAX_CONTENT_TOKENS = 22000;
    
    let processedMarkdown = markdown;
    const markdownTokens = estimateTokens(markdown);
    
    log.info('Token estimation', {
      markdownTokens,
      maxContentTokens: MAX_CONTENT_TOKENS,
      needsTruncation: markdownTokens > MAX_CONTENT_TOKENS
    });
    
    if (markdownTokens > MAX_CONTENT_TOKENS) {
      log.warn('Truncating markdown', {
        from: markdownTokens,
        to: MAX_CONTENT_TOKENS
      });
      processedMarkdown = truncateContent(markdown, MAX_CONTENT_TOKENS);
    }

    const systemPrompt = 'You are an AI writing assistant that helps edit and improve text.';
    let userPrompt;
    
    if (selectedText && selectedText.trim()) {
      userPrompt = `Edit the selected text: "${selectedText}"\n\nUser request: ${prompt}\n\nFull document context: ${processedMarkdown}`;
      log.info('Using selected text mode', { selectedTextLength: selectedText.length });
    } else {
      userPrompt = `Edit this document based on the request: ${prompt}\n\nDocument: ${processedMarkdown}`;
      log.info('Using full document mode');
    }

    // FIXED: Model and max_tokens adjusted
    const bodyPayload = JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: true,
      max_tokens: 4000, // Reduced to fit within TPM limits
      temperature: 0.3
    });

    log.info('Initiating OpenAI API request', {
      model: 'gpt-4o',
      maxTokens: 4000,
      temperature: 0.3,
      payloadSize: bodyPayload.length,
      estimatedInputTokens: estimateTokens(JSON.stringify(bodyPayload))
    });

    if (!process.env.OPENAI_API_KEY) {
      log.error('OPENAI_API_KEY environment variable not set', new Error('Missing API key'));
      return {
        statusCode: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        },
        body: JSON.stringify({ 
          error: 'Server configuration error',
          details: 'API key not configured'
        })
      };
    }

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }, res => {
        log.info('OpenAI API response received', {
          statusCode: res.statusCode,
          headers: res.headers
        });

        if (res.statusCode !== 200) {
          let errorBody = '';
          res.on('data', chunk => {
            errorBody += chunk.toString();
          });
          
          res.on('end', () => {
            log.error('OpenAI API returned error status', new Error('API Error'), {
              statusCode: res.statusCode,
              responseBody: errorBody
            });
            
            resolve({
              statusCode: res.statusCode,
              headers: { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              },
              body: JSON.stringify({ 
                error: 'OpenAI API error',
                statusCode: res.statusCode,
                details: errorBody
              })
            });
          });
          return;
        }

        let streamResponse = '';
        let chunkCount = 0;

        res.on('data', chunk => {
          chunkCount++;
          const lines = chunk.toString().split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              
              if (data === '[DONE]') {
                streamResponse += 'data: [DONE]\n\n';
                log.info('OpenAI streaming completed', {
                  chunksReceived: chunkCount,
                  duration: Date.now() - startTime,
                  responseSize: streamResponse.length
                });
                continue;
              }
              
              if (data) {
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.choices?.[0]?.delta?.content) {
                    const content = parsed.choices[0].delta.content;
                    streamResponse += `data: ${JSON.stringify({ content })}\n\n`;
                  }
                } catch (parseError) {
                  log.warn('Failed to parse streaming chunk', {
                    error: parseError.message,
                    chunk: data.substring(0, 100)
                  });
                }
              }
            }
          }
        });

        res.on('end', () => {
          const duration = Date.now() - startTime;
          log.info('Request completed successfully', {
            duration,
            chunksReceived: chunkCount,
            responseSize: streamResponse.length
          });
          
          resolve({
            statusCode: 200,
            headers: { 
              'Content-Type': 'text/event-stream',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-cache'
            },
            body: streamResponse
          });
        });

        res.on('error', err => {
          log.error('OpenAI response stream error', err, {
            duration: Date.now() - startTime,
            chunksReceived: chunkCount
          });
          
          resolve({
            statusCode: 500,
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ 
              error: 'OpenAI API error', 
              details: err.message,
              errorName: err.name
            })
          });
        });
      });

      req.on('error', err => {
        log.error('HTTPS request error', err, {
          hostname: 'api.openai.com',
          path: '/v1/chat/completions'
        });
        
        resolve({
          statusCode: 500,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: JSON.stringify({ 
            error: 'Request failed', 
            details: err.message,
            errorName: err.name,
            errorCode: err.code
          })
        });
      });

      req.on('timeout', () => {
        log.error('Request timeout', new Error('Request timed out'), {
          hostname: 'api.openai.com',
          duration: Date.now() - startTime
        });
        req.destroy();
      });

      try {
        req.write(bodyPayload);
        req.end();
      } catch (writeError) {
        log.error('Failed to write request payload', writeError, {
          payloadSize: bodyPayload.length
        });
        
        resolve({
          statusCode: 500,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          },
          body: JSON.stringify({ 
            error: 'Failed to send request',
            details: writeError.message
          })
        });
      }
    });

  } catch (error) {
    log.error('Unhandled error in Lambda handler', error, {
      eventType: typeof event,
      hasBody: !!event.body
    });
    
    return {
      statusCode: 500,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ 
        error: 'Internal server error', 
        details: error.message,
        errorName: error.name,
        stack: error.stack
      })
    };
  }
};
