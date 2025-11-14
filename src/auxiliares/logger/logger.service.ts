import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';

@Injectable()
export class LoggerService implements NestLoggerService {
  constructor(private context: string) {}

  log(message: string, ...optionalParams: any[]) {
    console.log(`[${this.context}] ${message}`, ...optionalParams);
  }

  error(message: string, trace?: string, ...optionalParams: any[]) {
    console.error(`[${this.context}] ${message}`, trace, ...optionalParams);
  }

  warn(message: string, ...optionalParams: any[]) {
    console.warn(`[${this.context}] ${message}`, ...optionalParams);
  }

  debug(message: string, ...optionalParams: any[]) {
    if (process.env.NODE_ENV === 'development') {
      console.debug(`[${this.context}] ${message}`, ...optionalParams);
    }
  }

  verbose(message: string, ...optionalParams: any[]) {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[${this.context}] [VERBOSE] ${message}`, ...optionalParams);
    }
  }
}
