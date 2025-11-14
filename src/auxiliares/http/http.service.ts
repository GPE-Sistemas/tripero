import { Injectable } from '@nestjs/common';
import { HttpService as NestHttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { API_DATOS_URL } from '../../env';
import { LoggerService } from '../logger/logger.service';

@Injectable()
export class HttpService {
  private logger = new LoggerService('HttpService');

  constructor(private httpService: NestHttpService) {}

  async get<T>(path: string, config?: any): Promise<T> {
    try {
      const url = `${API_DATOS_URL}${path}`;
      this.logger.debug(`GET ${url}`);

      const response = await firstValueFrom(
        this.httpService.get<T>(url, config),
      );

      return response.data;
    } catch (error) {
      this.logger.error(`Error in GET ${path}:`, error.message);
      throw error;
    }
  }

  async post<T>(path: string, data: any, config?: any): Promise<T> {
    try {
      const url = `${API_DATOS_URL}${path}`;
      this.logger.debug(`POST ${url}`);

      const response = await firstValueFrom(
        this.httpService.post<T>(url, data, config),
      );

      return response.data;
    } catch (error) {
      this.logger.error(`Error in POST ${path}:`, error.message);
      throw error;
    }
  }

  async put<T>(path: string, data: any, config?: any): Promise<T> {
    try {
      const url = `${API_DATOS_URL}${path}`;
      this.logger.debug(`PUT ${url}`);

      const response = await firstValueFrom(
        this.httpService.put<T>(url, data, config),
      );

      return response.data;
    } catch (error) {
      this.logger.error(`Error in PUT ${path}:`, error.message);
      throw error;
    }
  }

  async delete<T>(path: string, config?: any): Promise<T> {
    try {
      const url = `${API_DATOS_URL}${path}`;
      this.logger.debug(`DELETE ${url}`);

      const response = await firstValueFrom(
        this.httpService.delete<T>(url, config),
      );

      return response.data;
    } catch (error) {
      this.logger.error(`Error in DELETE ${path}:`, error.message);
      throw error;
    }
  }
}
