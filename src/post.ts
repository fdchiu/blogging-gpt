import { oraPromise } from 'ora'
import { ChatGPTAPI, ChatMessage } from 'chatgpt'
import pRetry, { AbortError } from 'p-retry'
import { extractPostOutlineFromCodeBlock, extractHtmlCodeBlock } from './lib/extractor'
import {
  getPromptForOutline,
  getPromptForIntroduction,
  getPromptForSection,
  getPromptForConclusion,
  getPromptForSeoTitle,
  getPromptForSeoDescription,
  getPromptForUrl,
  getPromptForWritingLikeAHuman
} from './lib/prompts'
import { PostPrompt, Section, PostOutline, PostGeneratorOptions, Post } from './types'

export interface GeneratorHelperInterface {
  getPrompt () : PostPrompt
  generateContentOutline () : Promise<PostOutline>
  askToWriteLikeAHuman () : Promise<String>
  generateIntroduction () : Promise<string>
  generateConclusion () : Promise<string>
  generateSectionContents (tableOfContent : PostOutline) : Promise<string>
  generateSEOTitle() : Promise<string>
  generateSEODescription() : Promise<string>
  generateUrl() : Promise<string>
}

export class ChatGptHelper implements GeneratorHelperInterface {
  private api : ChatGPTAPI
  private chatMessage : ChatMessage

  public constructor (private postPrompt : PostPrompt, private options? : PostGeneratorOptions) {
    this.api = new ChatGPTAPI({
      apiKey: options?.apiKey || process.env.OPENAI_API_KEY,
      completionParams: { model: options?.model || 'gpt-4' },
      maxModelTokens: options?.maxModelTokens || 8100 // not 8192 because we're leaving some buffer room
    })

    if (options.debug) {
      console.log(`OpenAI API initialized with model : ${options.model} and maxModelTokens : ${options.maxModelTokens}`)
    }
  }

  public getPrompt () {
    return this.postPrompt
  }

  async generateContentOutline () {
    const prompt = getPromptForOutline(this.postPrompt)
    if (this.options?.debug) {
      console.log('---------- PROMPT ----------')
      console.log(prompt)
    }
    this.chatMessage = await this.sendRequest(prompt)
    if (this.options?.debug) {
      console.log('---------- OUTLINE ----------')
      console.log(this.chatMessage.text)
    }

    return extractPostOutlineFromCodeBlock(this.chatMessage.text)
  }

  async askToWriteLikeAHuman () {
    this.chatMessage = await this.sendRequest(getPromptForWritingLikeAHuman())
    if (this.options?.debug) {
      console.log('---------- Write like a human --------')
      console.log(this.chatMessage.text)
    }
    return this.chatMessage.text
  }

  async generateIntroduction () {
    this.chatMessage = await this.sendRequest(getPromptForIntroduction(this.postPrompt.language))
    return extractHtmlCodeBlock(this.chatMessage.text)
  }

  async generateConclusion () {
    this.chatMessage = await this.sendRequest(getPromptForConclusion(this.postPrompt.language))
    return extractHtmlCodeBlock(this.chatMessage.text)
  }

  async generateSEOTitle () {
    this.chatMessage = await this.sendRequest(getPromptForSeoTitle(this.postPrompt.language))
    return this.chatMessage.text
  }

  async generateSEODescription () {
    this.chatMessage = await this.sendRequest(getPromptForSeoDescription(this.postPrompt.language))
    return this.chatMessage.text
  }

  async generateUrl () {
    this.chatMessage = await this.sendRequest(getPromptForUrl(this.postPrompt.language))
    return this.chatMessage.text
  }

  async generateSectionContents (postOutline : PostOutline) {
    const headingLevel = 2

    return await this.getHeadingContent(postOutline.sections, headingLevel, '', '')
  }

  private async getHeadingContent (sections: Section[], headingLevel: number, htmlContent: string, sectionDescription: string): Promise<string> {
    return await sections.reduce(async (htmlContentPromise, section) => {
      let htmlContent = await htmlContentPromise
      htmlContent += `<h${headingLevel}>${section.title}</h${headingLevel}>\n`

      const generateHtmlContent = async (withSections: boolean, sectionTitle: string) => {
        if (withSections) {
          return await this.getHeadingContent(section.sections, headingLevel + 1, htmlContent, sectionDescription + ' >> ' + sectionTitle)
        } else {
          return await this.getChapterContent(this.postPrompt.language, sectionDescription + ' >> ' + sectionTitle, section.keywords)
        }
      }

      htmlContent += await generateHtmlContent(!!section.sections, section.title)

      return Promise.resolve(htmlContent)
    }, Promise.resolve(''))
  }

  private async getChapterContent (language : string, chapterDescription : string, keywords : string[]) {
    if (this.options?.debug) {
      console.log(`\nChapter : ${chapterDescription}  ...'\n`)
    }
    this.chatMessage = await this.sendRequest(getPromptForSection(language, chapterDescription, keywords))
    return `${extractHtmlCodeBlock(this.chatMessage.text)}\n\n`
  }

  private async sendRequest (prompt : string) {
    return await pRetry(async () => {
      return await this.api.sendMessage(prompt, {
        parentMessageId: this.chatMessage?.id
      })
    }, {
      retries: 10,
      onFailedAttempt: async (error) => {
        if (error instanceof AbortError) {
          console.log('OpenAI API - Request aborted')
        } else {
          console.log(`OpenAI API - Request failed - Attempt ${error.attemptNumber} failed. There are ${error.retriesLeft} retries left.`)
        }
      }
    })
  }
}

export class PostGenerator {
  private helper : GeneratorHelperInterface
  public constructor (helper : GeneratorHelperInterface) {
    this.helper = helper
  }

  public async generate () : Promise<Post> {
    await oraPromise(
      this.helper.askToWriteLikeAHuman(),
      {
        text: 'Ask to write like a human ...'
      }
    )

    const tableOfContent = await oraPromise(
      this.helper.generateContentOutline(),
      {
        text: 'Generating post outline ...'
      }
    )

    const introduction = await oraPromise(
      this.helper.generateIntroduction(),
      {
        text: 'Generating introduction...'
      }
    )

    let htmlContent = await oraPromise(
      this.helper.generateSectionContents(tableOfContent),
      {
        text: 'Generating content ...'
      }
    )

    if (this.helper.getPrompt().withConclusion) {
      htmlContent += await oraPromise(
        this.helper.generateConclusion(),
        {
          text: 'Generating conclusion...'
        }
      )
    }

    const seoTitle = await oraPromise(
      this.helper.generateSEOTitle(),
      {
        text: 'Generating title seo ...'
      }
    )

    const seoDescription = await oraPromise(
      this.helper.generateSEODescription(),
      {
        text: 'Generating description seo ...'
      }
    )

    const slug = await oraPromise(
      this.helper.generateUrl(),
      {
        text: 'Generating url ...'
      }
    )

    return {
      slug,
      seoTitle,
      seoDescription,
      title : tableOfContent.title,
      content: `${introduction}\n${htmlContent}`
    }
  }
}

export class ChatGptPostGenerator extends PostGenerator {
  public constructor (postPrompt : PostPrompt, options? : PostGeneratorOptions) {
    super(new ChatGptHelper(postPrompt, options))
  }
}
